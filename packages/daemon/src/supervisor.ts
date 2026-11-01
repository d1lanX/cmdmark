import { createWriteStream } from 'node:fs';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { WriteStream } from 'node:fs';
import type { RunRecord, RunSignal, RunState, RpcNotification, SettingsRecord } from '@cmdmark/protocol';
import { CommandStore } from './store.ts';
import { ByteRingBuffer } from './ring-buffer.ts';
import { BunPtyBackend, type ProcessDescriptor, type ProcessExit, type PtyBackend } from './pty.ts';

export interface StartRunOptions {
	commandId?: string | null;
	resolvedCommand: string;
	cwd?: string | null;
	shell?: string;
	env?: Record<string, string>;
	cols?: number;
	rows?: number;
}

export interface SupervisorOptions {
	store: CommandStore;
	backend?: PtyBackend;
	logDirectory?: string;
	bufferSizeBytes?: number;
	gracePeriodMs?: number;
}

export interface LogRead {
	data: Buffer;
	offset: number;
	nextOffset: number;
	truncated: boolean;
}

interface ActiveRun {
	ring: ByteRingBuffer;
	writer: WriteStream;
	descriptor: ProcessDescriptor | null;
	exitPromise: Promise<ProcessExit>;
	resolveExit(exit: ProcessExit): void;
	logClosed: Promise<void>;
	resolveLogClosed(): void;
	logError: Error | null;
}

type StopOutcome = 'stopped' | 'killed';
type NotificationListener = (notification: RpcNotification) => void;

const DEFAULT_BUFFER_SIZE_BYTES = 256 * 1024;
const MAX_LOG_READ_BYTES = 1024 * 1024;

export class ProcessSupervisor {
	readonly store: CommandStore;
	readonly backend: PtyBackend;
	readonly logDirectory: string;
	bufferSizeBytes: number;
	gracePeriodMs: number;
	#active = new Map<string, ActiveRun>();
	#stopOutcome = new Map<string, StopOutcome>();
	#listeners = new Set<NotificationListener>();

	constructor(options: SupervisorOptions) {
		this.store = options.store;
		this.backend = options.backend ?? new BunPtyBackend();
		this.logDirectory = options.logDirectory ?? defaultLogDirectory();
		this.bufferSizeBytes = positiveInteger(options.bufferSizeBytes ?? DEFAULT_BUFFER_SIZE_BYTES, 'bufferSizeBytes');
		this.gracePeriodMs = nonNegativeInteger(options.gracePeriodMs ?? 5000, 'gracePeriodMs');
	}

	updateSettings(settings: Pick<SettingsRecord, 'bufferSizeBytes' | 'gracePeriodMs'>): void {
		const bufferSizeBytes = positiveInteger(settings.bufferSizeBytes, 'bufferSizeBytes');
		this.gracePeriodMs = nonNegativeInteger(settings.gracePeriodMs, 'gracePeriodMs');
		this.bufferSizeBytes = bufferSizeBytes;
		for (const active of this.#active.values()) active.ring.resize(bufferSizeBytes);
	}

	async start(options: StartRunOptions): Promise<RunRecord> {
		const command = requiredText(options.resolvedCommand, 'resolvedCommand');
		const shell = requiredText(options.shell ?? this.store.defaultShell, 'shell');
		const commandId = options.commandId ?? null;
		if (commandId && !this.store.getCommand(commandId)) throw new Error(`command not found: ${commandId}`);

		await mkdir(this.logDirectory, { recursive: true, mode: 0o700 });
		const runId = crypto.randomUUID();
		const logPath = join(this.logDirectory, `${runId}.log`);
		const startedAt = Date.now();
		this.store.createRun({ runId, commandId, resolvedCommand: command, cwd: options.cwd ?? null, logPath, startedAt });
		if (commandId) this.store.markCommandUsed(commandId, startedAt);

		const active = this.#createActiveRun();
		active.writer = createWriteStream(logPath, { flags: 'a', mode: 0o600 });
		active.writer.on('error', (error: Error) => {
			active.logError = error;
		});
		active.writer.once('close', () => active.resolveLogClosed());
		this.#active.set(runId, active);

		try {
			const descriptor = this.backend.spawn({
				runId,
				shell,
				command,
				cwd: options.cwd ?? null,
				env: mergeEnvironment(options.env),
				cols: options.cols ?? 80,
				rows: options.rows ?? 24,
				onData: (data) => this.#onData(runId, active, data),
				onExit: (exit) => this.#onExit(runId, active, exit)
			});
			active.descriptor = descriptor;
			const run = this.store.updateRun(runId, {
				state: 'running',
				pid: descriptor.pid,
				pgid: descriptor.pgid,
				procStartTime: descriptor.procStartTime
			});
			this.#publish({ jsonrpc: '2.0', method: 'run.state', params: { run } });
			return run;
		} catch (error) {
			this.#active.delete(runId);
			active.writer.end();
			const run = this.store.updateRun(runId, { state: 'failed', endedAt: Date.now(), exitCode: 127 });
			this.#publish({ jsonrpc: '2.0', method: 'run.state', params: { run } });
			throw error;
		}
	}

	write(runId: string, data: string | Uint8Array): void {
		this.backend.write(runId, data);
	}

	resize(runId: string, cols: number, rows: number): void {
		this.backend.resize(runId, cols, rows);
	}

	async signal(runId: string, signal: RunSignal): Promise<RunRecord> {
		const current = this.#requireRun(runId);
		if (current.endedAt !== null) return current;
		if (signal === 'SIGKILL') return this.kill(runId);
		if (signal === 'SIGSTOP') {
			await this.backend.kill(runId, signal);
			const run = this.store.updateRun(runId, { state: 'stopped', signal, endedAt: null });
			this.#publish({ jsonrpc: '2.0', method: 'run.state', params: { run } });
			return run;
		}
		if (signal === 'SIGCONT') {
			await this.backend.kill(runId, signal);
			const run = this.store.updateRun(runId, { state: 'running', signal: null, endedAt: null });
			this.#publish({ jsonrpc: '2.0', method: 'run.state', params: { run } });
			return run;
		}
		if (!this.#active.has(runId)) return current;
		await this.backend.kill(runId, signal);
		return this.#requireRun(runId);
	}

	async stop(runId: string, gracePeriodMs = this.gracePeriodMs): Promise<RunRecord> {
		const current = this.#requireRun(runId);
		if (current.endedAt !== null) return current;
		const active = this.#active.get(runId);
		if (!active) return current;
		const grace = nonNegativeInteger(gracePeriodMs, 'gracePeriodMs');
		this.#stopOutcome.set(runId, 'stopped');
		if (current.state === 'stopped' && current.endedAt === null) {
			await this.backend.kill(runId, 'SIGCONT');
		}
		await this.backend.kill(runId, 'SIGTERM');

		const outcome = await waitForExit(active.exitPromise, grace);
		if (outcome === 'timeout') {
			this.#stopOutcome.set(runId, 'killed');
			await this.backend.kill(runId, 'SIGKILL');
			await active.exitPromise;
		}
		return this.#requireRun(runId);
	}

	async kill(runId: string): Promise<RunRecord> {
		const current = this.#requireRun(runId);
		const active = this.#active.get(runId);
		if (!active) return current;
		this.#stopOutcome.set(runId, 'killed');
		await this.backend.kill(runId, 'SIGKILL');
		await active.exitPromise;
		return this.#requireRun(runId);
	}

	async restart(runId: string): Promise<RunRecord> {
		const previous = this.#requireRun(runId);
		const command = previous.commandId ? this.store.getCommand(previous.commandId) : null;
		await this.stop(runId);
		return this.start({
			commandId: previous.commandId,
			resolvedCommand: previous.resolvedCommand,
			cwd: previous.cwd,
			shell: command?.shell,
			env: command?.env
		});
	}

	list(): RunRecord[] {
		return this.store.listRuns();
	}

	listProcesses(): ProcessDescriptor[] {
		return this.backend.list();
	}

	async deleteRun(runId: string): Promise<boolean> {
		const run = this.#requireRun(runId);
		if (run.endedAt === null || this.backend.list().some((process) => process.runId === runId)) {
			throw new Error('stop the run before deleting its history');
		}
		const active = this.#active.get(runId);
		if (active) await active.logClosed;
		await removeLogFile(run.logPath);
		return this.store.deleteRun(runId);
	}

	async clearHistory(): Promise<{ deletedRunIds: string[]; failedRunIds: string[] }> {
		const candidates = this.store.listRuns().filter((run) => run.endedAt !== null);
		const deletedRunIds: string[] = [];
		const failedRunIds: string[] = [];
		for (const run of candidates) {
			try {
				if (await this.deleteRun(run.runId)) deletedRunIds.push(run.runId);
			} catch {
				failedRunIds.push(run.runId);
			}
		}
		return { deletedRunIds, failedRunIds };
	}

	async readLogs(runId: string, offset?: number, limit = this.bufferSizeBytes): Promise<LogRead> {
		const run = this.#requireRun(runId);
		const maxBytes = Math.max(0, Math.min(MAX_LOG_READ_BYTES, Math.trunc(limit)));
		let active = this.#active.get(runId);
		if (active && run.endedAt !== null) {
			await active.logClosed;
			active = this.#active.get(runId);
		}
		if (active) {
			if (offset === undefined) {
				const read = active.ring.read(undefined, maxBytes);
				return { data: read.data, offset: read.offset, nextOffset: read.nextOffset, truncated: read.truncated };
			}
			if (offset >= active.ring.startOffset && offset <= active.ring.totalBytes) {
				const read = active.ring.read(offset, maxBytes);
				return { data: read.data, offset: read.offset, nextOffset: read.nextOffset, truncated: read.truncated };
			}
			await flushWriter(active);
		}
		return readLogFile(run.logPath, offset, maxBytes);
	}

	subscribe(listener: NotificationListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	async shutdown(): Promise<void> {
		const activeRuns = [...this.#active.entries()];
		await Promise.all(activeRuns.map(async ([runId, active]) => {
			await this.stop(runId);
			await active.logClosed;
		}));
	}

	#createActiveRun(): ActiveRun {
		let resolveExit!: (exit: ProcessExit) => void;
		let resolveLogClosed!: () => void;
		const active: ActiveRun = {
			ring: new ByteRingBuffer(this.bufferSizeBytes),
			writer: undefined as unknown as WriteStream,
			descriptor: null,
			exitPromise: new Promise((resolve) => (resolveExit = resolve)),
			resolveExit: (exit) => resolveExit(exit),
			logClosed: new Promise((resolve) => (resolveLogClosed = resolve)),
			resolveLogClosed: () => resolveLogClosed(),
			logError: null
		};
		return active;
	}

	#onData(runId: string, active: ActiveRun, data: Uint8Array): void {
		if (data.byteLength === 0) return;
		const offset = active.ring.append(data);
		active.writer.write(Buffer.from(data));
		this.#publish({
			jsonrpc: '2.0',
			method: 'run.output',
			params: { runId, offset, dataBase64: Buffer.from(data).toString('base64') }
		});
	}

	#onExit(runId: string, active: ActiveRun, exit: ProcessExit): void {
		const requestedOutcome = this.#stopOutcome.get(runId);
		this.#stopOutcome.delete(runId);
		const state: RunState = requestedOutcome ?? (exit.signal === 'SIGKILL' ? 'killed' : 'exited');
		let run = this.store.getRun(runId);
		if (run) {
			run = this.store.updateRun(runId, {
				state,
				endedAt: Date.now(),
				exitCode: exit.exitCode,
				signal: exit.signal
			});
			this.#publish({ jsonrpc: '2.0', method: 'run.state', params: { run } });
		}
		active.writer.end();
		void active.logClosed.then(() => this.#active.delete(runId));
		active.resolveExit(exit);
	}

	#requireRun(runId: string): RunRecord {
		const run = this.store.getRun(runId);
		if (!run) throw new Error(`run not found: ${runId}`);
		return run;
	}

	#publish(notification: RpcNotification): void {
		for (const listener of this.#listeners) {
			try {
				listener(notification);
			} catch {
				// A disconnected or faulty subscriber must not interrupt process supervision.
			}
		}
	}
}

function defaultLogDirectory(): string {
	const stateHome = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
	return join(stateHome, 'cmdmark', 'logs');
}

function mergeEnvironment(overrides: Record<string, string> | undefined): Record<string, string> {
	const merged: Record<string, string> = {};
	for (const [key, value] of Object.entries({ ...process.env, ...overrides })) {
		if (value !== undefined) merged[key] = value;
	}
	return merged;
}

function requiredText(value: string, name: string): string {
	if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${name} is required`);
	return value;
}

function positiveInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 1) throw new RangeError(`${name} must be a positive integer`);
	return value;
}

function nonNegativeInteger(value: number, name: string): number {
	if (!Number.isInteger(value) || value < 0) throw new RangeError(`${name} must be a non-negative integer`);
	return value;
}

async function waitForExit(exit: Promise<ProcessExit>, gracePeriodMs: number): Promise<'exited' | 'timeout'> {
	if (gracePeriodMs === 0) return Promise.race([exit.then(() => 'exited' as const), Promise.resolve('timeout' as const)]);
	let timeout: ReturnType<typeof setTimeout> | undefined;
	const expired = new Promise<'timeout'>((resolve) => {
		timeout = setTimeout(() => resolve('timeout'), gracePeriodMs);
	});
	const outcome = await Promise.race([exit.then(() => 'exited' as const), expired]);
	if (timeout) clearTimeout(timeout);
	return outcome;
}

async function flushWriter(active: ActiveRun): Promise<void> {
	if (active.writer.closed || active.writer.destroyed) return;
	await new Promise<void>((resolve, reject) => {
		active.writer.write(Buffer.alloc(0), (error?: Error | null) => error ? reject(error) : resolve());
	});
}

async function readLogFile(path: string, requestedOffset: number | undefined, limit: number): Promise<LogRead> {
	try {
		const fileStat = await stat(path);
		const start = requestedOffset === undefined ? Math.max(0, fileStat.size - limit) : Math.max(0, Math.trunc(requestedOffset));
		const offset = Math.min(start, fileStat.size);
		const size = Math.min(limit, fileStat.size - offset);
		const data = Buffer.allocUnsafe(size);
		const handle = await open(path, 'r');
		try {
			const { bytesRead } = await handle.read(data, 0, size, offset);
			return {
				data: bytesRead === size ? data : data.subarray(0, bytesRead),
				offset,
				nextOffset: offset + bytesRead,
				truncated: requestedOffset === undefined && offset > 0
			};
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') {
			return { data: Buffer.alloc(0), offset: requestedOffset ?? 0, nextOffset: requestedOffset ?? 0, truncated: false };
		}
		throw error;
	}
}

async function removeLogFile(path: string): Promise<void> {
	try {
		await unlink(path);
	} catch (error) {
		if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return;
		throw error;
	}
}
