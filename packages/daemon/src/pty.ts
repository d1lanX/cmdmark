import { readdirSync, readFileSync } from 'node:fs';
import { constants as osConstants } from 'node:os';
import type { RunSignal } from '@cmdmark/protocol';

export interface ProcessDescriptor {
	runId: string;
	pid: number;
	pgid: number;
	procStartTime: string | null;
}

export interface ProcessExit {
	exitCode: number | null;
	signal: string | null;
}

export interface SpawnPtyOptions {
	runId: string;
	shell: string;
	command: string;
	cwd: string | null;
	env: Record<string, string>;
	cols: number;
	rows: number;
	onData(data: Uint8Array): void;
	onExit(exit: ProcessExit): void;
}

export interface PtyBackend {
	spawn(options: SpawnPtyOptions): ProcessDescriptor;
	write(runId: string, data: string | Uint8Array): void;
	resize(runId: string, cols: number, rows: number): void;
	kill(runId: string, signal: RunSignal): Promise<void>;
	list(): ProcessDescriptor[];
}

interface ManagedProcess {
	descriptor: ProcessDescriptor;
	process: ReturnType<typeof Bun.spawn>;
}

interface ProcStat {
	pid: number;
	processGroup: number;
	session: number;
	startTime: string;
}

export class BunPtyBackend implements PtyBackend {
	#processes = new Map<string, ManagedProcess>();

	spawn(options: SpawnPtyOptions): ProcessDescriptor {
		if (this.#processes.has(options.runId)) throw new Error(`run already has a PTY: ${options.runId}`);
		const process = Bun.spawn([options.shell, '-c', options.command], {
			cwd: options.cwd ?? undefined,
			env: options.env,
			terminal: {
				cols: clampDimension(options.cols),
				rows: clampDimension(options.rows),
				data: (_terminal, data) => options.onData(data)
			},
			onExit: (_process, exitCode, signalCode) => {
				this.#processes.delete(options.runId);
				options.onExit({ exitCode, signal: signalName(signalCode) });
			}
		});
		const descriptor: ProcessDescriptor = {
			runId: options.runId,
			pid: process.pid,
			pgid: process.pid,
			procStartTime: readProcStat(process.pid)?.startTime ?? null
		};
		this.#processes.set(options.runId, { descriptor, process });
		return descriptor;
	}

	write(runId: string, data: string | Uint8Array): void {
		const managed = this.#requireProcess(runId);
		if (!managed.process.terminal || managed.process.terminal.closed) throw new Error(`PTY is closed: ${runId}`);
		managed.process.terminal.write(data);
	}

	resize(runId: string, cols: number, rows: number): void {
		const terminal = this.#requireProcess(runId).process.terminal;
		if (!terminal || terminal.closed) throw new Error(`PTY is closed: ${runId}`);
		terminal.resize(clampDimension(cols), clampDimension(rows));
	}

	async kill(runId: string, signal: RunSignal): Promise<void> {
		const managed = this.#processes.get(runId);
		if (!managed) return;
		signalProcessGroupSafely(managed.descriptor, signal);
	}

	list(): ProcessDescriptor[] {
		return [...this.#processes.values()].map(({ descriptor }) => ({ ...descriptor }));
	}

	#requireProcess(runId: string): ManagedProcess {
		const managed = this.#processes.get(runId);
		if (!managed) throw new Error(`run has no active PTY: ${runId}`);
		return managed;
	}
}

export function readProcStat(pid: number): ProcStat | null {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		const closeParen = stat.lastIndexOf(')');
		if (closeParen === -1) return null;
		const fields = stat.slice(closeParen + 1).trim().split(/\s+/);
		return {
			pid,
			processGroup: Number(fields[2]),
			session: Number(fields[3]),
			startTime: fields[19]
		};
	} catch {
		return null;
	}
}

function processGroupStillMatches(descriptor: ProcessDescriptor): boolean {
	const leader = readProcStat(descriptor.pid);
	if (leader && leader.startTime === descriptor.procStartTime && leader.processGroup === descriptor.pgid) return true;
	if (descriptor.procStartTime === null) return false;

	// A shell may exit while one of its children remains in the PTY's session. The session
	// ID cannot be reused while that session still contains a process, so this also avoids
	// signaling an unrelated group after PID reuse.
	for (const entry of readdirSync('/proc')) {
		if (!/^\d+$/.test(entry)) continue;
		const stat = readProcStat(Number(entry));
		if (stat?.processGroup === descriptor.pgid && stat.session === descriptor.pgid) return true;
	}
	return false;
}

export function processGroupExists(descriptor: ProcessDescriptor): boolean {
	return processGroupStillMatches(descriptor);
}

export function signalProcessGroupSafely(descriptor: ProcessDescriptor, signal: RunSignal): boolean {
	if (!processGroupStillMatches(descriptor)) return false;
	try {
		process.kill(-descriptor.pgid, signal);
		return true;
	} catch (error) {
		if (isMissingProcess(error)) return false;
		throw error;
	}
}

function signalName(signal: string | number | null): string | null {
	if (signal === null) return null;
	if (typeof signal === 'string') return signal;
	for (const [name, number] of Object.entries(osConstants.signals)) {
		if (number === signal) return name;
	}
	return String(signal);
}

function isMissingProcess(error: unknown): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH';
}

function clampDimension(value: number): number {
	if (!Number.isFinite(value)) return 80;
	return Math.max(1, Math.min(1000, Math.trunc(value)));
}
