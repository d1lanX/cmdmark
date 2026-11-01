import { createConnection, createServer, type Server, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import { chmod, lstat, mkdir, stat, unlink } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type {
	CommandDraft,
	CommandPatch,
	RpcId,
	RpcMessage,
	RpcMethod,
	RpcNotification,
	RpcParams,
	RpcRequest,
	RpcResponse,
	RunSignal
} from '@cmdmark/protocol';
import { errorResponse, isRpcRequest, RPC_METHODS } from '@cmdmark/protocol';
import { findImportRisks, parseBookmarkExport, serializeBookmarks } from '@cmdmark/protocol/bookmarks';
import { CommandStore } from './store.ts';
import { ProcessSupervisor } from './supervisor.ts';

interface ClientConnection {
	socket: Socket;
	decoder: StringDecoder;
	buffer: string;
	subscriptions: Map<string, { runId: string | null; includeOutput: boolean }>;
	attachments: Set<string>;
	closed: boolean;
}

export interface DaemonSocketServerOptions {
	store: CommandStore;
	supervisor: ProcessSupervisor;
	socketPath?: string;
	maxFrameBytes?: number;
}

class RpcDispatchError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(code: number, message: string, data?: unknown) {
		super(message);
		this.name = 'RpcDispatchError';
		this.code = code;
		this.data = data;
	}
}

const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;

export class DaemonSocketServer {
	readonly store: CommandStore;
	readonly supervisor: ProcessSupervisor;
	readonly socketPath: string;
	readonly maxFrameBytes: number;
	#server: Server | null = null;
	#clients = new Set<ClientConnection>();
	#attachOwners = new Map<string, ClientConnection>();
	#unsubscribeSupervisor: (() => void) | null = null;

	constructor(options: DaemonSocketServerOptions) {
		this.store = options.store;
		this.supervisor = options.supervisor;
		this.socketPath = options.socketPath ?? defaultSocketPath();
		this.maxFrameBytes = options.maxFrameBytes ?? DEFAULT_MAX_FRAME_BYTES;
	}

	async start(): Promise<void> {
		if (this.#server) throw new Error('daemon socket server is already started');
		await prepareSocketPath(this.socketPath);
		const server = createServer((socket) => this.#accept(socket));
		this.#server = server;
		await listenUnix(server, this.socketPath);
		await chmod(this.socketPath, 0o600);
		this.#unsubscribeSupervisor = this.supervisor.subscribe((notification) => this.#broadcast(notification));
	}

	async close(): Promise<void> {
		this.#unsubscribeSupervisor?.();
		this.#unsubscribeSupervisor = null;
		for (const client of this.#clients) client.socket.destroy();
		this.#clients.clear();
		this.#attachOwners.clear();
		const server = this.#server;
		this.#server = null;
		if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
		try {
			const existing = await lstat(this.socketPath);
			if (existing.isSocket()) await unlink(this.socketPath);
		} catch (error) {
			if (!isFsError(error, 'ENOENT')) throw error;
		}
	}

	#accept(socket: Socket): void {
		const client: ClientConnection = {
			socket,
			decoder: new StringDecoder('utf8'),
			buffer: '',
			subscriptions: new Map(),
			attachments: new Set(),
			closed: false
		};
		this.#clients.add(client);
		socket.on('data', (chunk: Buffer) => this.#onData(client, chunk));
		socket.on('error', () => this.#closeClient(client));
		socket.on('close', () => this.#closeClient(client));
	}

	#onData(client: ClientConnection, chunk: Buffer): void {
		client.buffer += client.decoder.write(chunk);
		if (Buffer.byteLength(client.buffer) > this.maxFrameBytes && !client.buffer.includes('\n')) {
			client.socket.destroy();
			return;
		}
		for (;;) {
			const newline = client.buffer.indexOf('\n');
			if (newline === -1) return;
			const line = client.buffer.slice(0, newline).trim();
			client.buffer = client.buffer.slice(newline + 1);
			if (!line) continue;
			if (Buffer.byteLength(line) > this.maxFrameBytes) {
				this.#send(client, errorResponse(null, -32600, 'JSON-RPC frame is too large'));
				client.socket.destroy();
				return;
			}
			this.#handleLine(client, line);
		}
	}

	#handleLine(client: ClientConnection, line: string): void {
		let value: unknown;
		try {
			value = JSON.parse(line);
		} catch {
			this.#send(client, errorResponse(null, -32700, 'Parse error'));
			return;
		}
		if (!isRpcRequest(value)) {
			const id = getRpcId(value);
			const method = getMethod(value);
			const isKnownMethod = method !== null && RPC_METHODS.includes(method as RpcMethod);
			this.#send(client, errorResponse(id, isKnownMethod ? -32602 : -32600, isKnownMethod ? 'Invalid params' : 'Invalid request'));
			return;
		}
		void this.#handleRequest(client, value).catch((error) => {
			this.#send(client, errorResponse(value.id, -32603, error instanceof Error ? error.message : String(error)));
		});
	}

	async #handleRequest(client: ClientConnection, request: RpcRequest): Promise<void> {
		try {
			const result = await this.#dispatch(client, request);
			this.#send(client, { jsonrpc: '2.0', id: request.id, result } as RpcResponse);
		} catch (error) {
			if (error instanceof RpcDispatchError) {
				this.#send(client, errorResponse(request.id, error.code, error.message, error.data));
			} else {
				this.#send(client, errorResponse(request.id, -32000, error instanceof Error ? error.message : String(error)));
			}
		}
	}

	async #dispatch(client: ClientConnection, request: RpcRequest): Promise<unknown> {
		switch (request.method) {
			case 'daemon.ping':
				return { version: '0.1.0', pid: process.pid };
			case 'commands.list':
				return { commands: this.store.listCommands(request.params) };
			case 'commands.get':
				return { command: this.store.getCommand(request.params.id) };
			case 'commands.create': {
				const command = this.store.createCommand(request.params.command as CommandDraft);
				this.#broadcast({ jsonrpc: '2.0', method: 'commands.changed', params: { commandId: command.id, change: 'created' } });
				return { command };
			}
			case 'commands.update': {
				const command = this.store.updateCommand(request.params.id, request.params.patch as CommandPatch);
				this.#broadcast({ jsonrpc: '2.0', method: 'commands.changed', params: { commandId: command.id, change: 'updated' } });
				return { command };
			}
			case 'commands.delete': {
				const deleted = this.store.deleteCommand(request.params.id);
				if (deleted) this.#broadcast({ jsonrpc: '2.0', method: 'commands.changed', params: { commandId: request.params.id, change: 'deleted' } });
				return { deleted };
			}
			case 'commands.duplicate': {
				const command = this.store.duplicateCommand(request.params.id);
				this.#broadcast({ jsonrpc: '2.0', method: 'commands.changed', params: { commandId: command.id, change: 'created' } });
				return { command };
			}
			case 'commands.favorite': {
				const command = this.store.setFavorite(request.params.id, request.params.favorite);
				this.#broadcast({ jsonrpc: '2.0', method: 'commands.changed', params: { commandId: command.id, change: 'updated' } });
				return { command };
			}
			case 'commands.search':
				return { hits: this.store.searchCommands(request.params.query, request.params), fts5: this.store.fts5Enabled };
			case 'commands.export':
				return { json: serializeBookmarks(this.store.listCommands()) };
			case 'commands.importPreview': {
				const commands = parseBookmarkExport(request.params.json);
				return { commands, risks: findImportRisks(commands) };
			}
			case 'commands.import': {
				const commands = this.store.db.transaction(() => request.params.commands.map((draft) => this.store.createCommand(draft)))();
				for (const command of commands) {
					this.#broadcast({ jsonrpc: '2.0', method: 'commands.changed', params: { commandId: command.id, change: 'created' } });
				}
				return { commands, risks: findImportRisks(request.params.commands) };
			}
			case 'runs.list':
				return { runs: this.store.listRuns(request.params.state) };
			case 'runs.get':
				return { run: this.store.getRun(request.params.runId) };
			case 'runs.delete': {
				const run = this.store.getRun(request.params.runId);
				if (!run) throw new RpcDispatchError(-32004, `run not found: ${request.params.runId}`);
				if (run.endedAt === null || this.supervisor.listProcesses().some((process) => process.runId === run.runId)) {
					throw new RpcDispatchError(-32009, 'stop the run before deleting its history');
				}
				const deleted = await this.supervisor.deleteRun(request.params.runId);
				if (deleted) this.#broadcast({ jsonrpc: '2.0', method: 'runs.deleted', params: { runIds: [request.params.runId] } });
				return { deleted };
			}
			case 'runs.clearHistory': {
				const result = await this.supervisor.clearHistory();
				if (result.deletedRunIds.length > 0) {
					this.#broadcast({ jsonrpc: '2.0', method: 'runs.deleted', params: { runIds: result.deletedRunIds } });
				}
				return result;
			}
			case 'runs.start': {
				const bookmarked = request.params.commandId ? this.store.getCommand(request.params.commandId) : null;
				if (request.params.commandId && !bookmarked) throw new RpcDispatchError(-32004, `command not found: ${request.params.commandId}`);
				const resolvedCommand = request.params.command ?? bookmarked?.command;
				if (!resolvedCommand) throw new RpcDispatchError(-32602, 'command or commandId is required');
				const run = await this.supervisor.start({
					commandId: request.params.commandId,
					resolvedCommand,
					cwd: request.params.cwd === undefined ? bookmarked?.cwd : request.params.cwd,
					shell: request.params.shell ?? bookmarked?.shell ?? this.store.getSettings().defaultShell,
					env: { ...bookmarked?.env, ...request.params.env }
				});
				return { run };
			}
			case 'runs.stop':
				return { run: await this.supervisor.stop(request.params.runId, request.params.gracePeriodMs ?? this.store.getSettings().gracePeriodMs) };
			case 'runs.signal':
				return { run: await this.supervisor.signal(request.params.runId, request.params.signal as RunSignal) };
			case 'runs.restart':
				return { run: await this.supervisor.restart(request.params.runId) };
			case 'runs.logs': {
				const logs = await this.supervisor.readLogs(request.params.runId, request.params.offset, request.params.limit);
				return { dataBase64: logs.data.toString('base64'), nextOffset: logs.nextOffset, truncated: logs.truncated };
			}
			case 'runs.subscribe': {
				const subscriptionId = randomUUID();
				client.subscriptions.set(subscriptionId, {
					runId: request.params.runId ?? null,
					includeOutput: request.params.includeOutput ?? false
				});
				return { subscriptionId };
			}
			case 'runs.unsubscribe':
				return { unsubscribed: client.subscriptions.delete(request.params.subscriptionId) };
			case 'runs.attach':
				return this.#attach(client, request.params.runId, request.params.cols, request.params.rows);
			case 'runs.write':
				this.#requireAttachOwner(client, request.params.runId);
				this.supervisor.write(request.params.runId, Buffer.from(request.params.dataBase64, 'base64'));
				return { written: true };
			case 'runs.resize':
				this.#requireAttachOwner(client, request.params.runId);
				this.supervisor.resize(request.params.runId, request.params.cols, request.params.rows);
				return { resized: true };
			case 'runs.detach':
				return { detached: this.#detach(client, request.params.runId) };
			case 'settings.get':
				return { settings: this.store.getSettings() };
			case 'settings.update': {
				const settings = this.store.updateSettings(request.params.patch);
				this.supervisor.updateSettings(settings);
				this.#broadcast({ jsonrpc: '2.0', method: 'settings.changed', params: { settings } });
				return { settings };
			}
		}
	}

	async #attach(client: ClientConnection, runId: string, cols: number, rows: number): Promise<unknown> {
		const run = this.store.getRun(runId);
		if (!run) throw new RpcDispatchError(-32004, `run not found: ${runId}`);
		if (run.endedAt !== null || !this.supervisor.listProcesses().some((process) => process.runId === runId)) {
			throw new RpcDispatchError(-32009, `run is not attachable: ${runId}`);
		}
		const owner = this.#attachOwners.get(runId);
		if (owner && owner !== client) throw new RpcDispatchError(-32010, `run already has an interactive attach: ${runId}`);
		this.#attachOwners.set(runId, client);
		client.attachments.add(runId);
		try {
			this.supervisor.resize(runId, cols, rows);
			const logs = await this.supervisor.readLogs(runId);
			return { attached: true, offset: logs.offset, initialOutputBase64: logs.data.toString('base64') };
		} catch (error) {
			this.#detach(client, runId);
			throw error;
		}
	}

	#requireAttachOwner(client: ClientConnection, runId: string): void {
		if (this.#attachOwners.get(runId) !== client) throw new RpcDispatchError(-32010, 'this connection does not own the interactive attach');
	}

	#detach(client: ClientConnection, runId: string): boolean {
		const owned = this.#attachOwners.get(runId) === client;
		if (owned) this.#attachOwners.delete(runId);
		client.attachments.delete(runId);
		return owned;
	}

	#broadcast(notification: RpcNotification): void {
		for (const client of this.#clients) {
			if (client.closed) continue;
			if (notification.method === 'run.state' || notification.method === 'run.output') {
				const runId = notification.method === 'run.state' ? notification.params.run.runId : notification.params.runId;
				const subscribed = [...client.subscriptions.values()].some((subscription) =>
					(subscription.runId === null || subscription.runId === runId) &&
					(notification.method === 'run.state' || subscription.includeOutput)
				);
				if (!subscribed && !client.attachments.has(runId)) continue;
			}
			this.#send(client, notification);
		}
	}

	#send(client: ClientConnection, message: RpcMessage | RpcResponse): void {
		if (client.closed || !client.socket.writable) return;
		try {
			client.socket.write(`${JSON.stringify(message)}\n`);
		} catch {
			this.#closeClient(client);
		}
	}

	#closeClient(client: ClientConnection): void {
		if (client.closed) return;
		client.closed = true;
		for (const runId of client.attachments) {
			if (this.#attachOwners.get(runId) === client) this.#attachOwners.delete(runId);
		}
		client.attachments.clear();
		client.subscriptions.clear();
		this.#clients.delete(client);
	}
}

export function defaultSocketPath(): string {
	const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
	if (!runtimeDirectory) throw new Error('XDG_RUNTIME_DIR is not set; cmdmark requires a user runtime directory');
	return `${runtimeDirectory.replace(/\/$/, '')}/cmdmark.sock`;
}

async function prepareSocketPath(socketPath: string): Promise<void> {
	const runtimeDirectory = dirname(socketPath);
	await mkdir(runtimeDirectory, { recursive: true, mode: 0o700 });
	const directory = await stat(runtimeDirectory);
	if (typeof process.getuid === 'function' && directory.uid !== process.getuid()) {
		throw new Error(`runtime directory is not owned by this user: ${runtimeDirectory}`);
	}
	if ((directory.mode & 0o077) !== 0) throw new Error(`runtime directory must not be accessible to other users: ${runtimeDirectory}`);
	try {
		const existing = await lstat(socketPath);
		if (!existing.isSocket()) throw new Error(`refusing to replace non-socket path: ${socketPath}`);
		if (await canConnect(socketPath)) throw new Error(`cmdmark daemon is already listening at ${socketPath}`);
		await unlink(socketPath);
	} catch (error) {
		if (!isFsError(error, 'ENOENT')) throw error;
	}
}

async function canConnect(path: string): Promise<boolean> {
	return new Promise((resolve, reject) => {
		const socket = createConnection({ path });
		let settled = false;
		const timer = setTimeout(() => finish(true), 500);
		const finish = (active: boolean, error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			socket.destroy();
			if (error) reject(error);
			else resolve(active);
		};
		socket.once('connect', () => finish(true));
		socket.once('error', (error: NodeJS.ErrnoException) => {
			if (error.code === 'ECONNREFUSED' || error.code === 'ENOENT') finish(false);
			else finish(false, error);
		});
	});
}

async function listenUnix(server: Server, socketPath: string): Promise<void> {
	const previousUmask = process.umask(0o177);
	await new Promise<void>((resolve, reject) => {
		const onError = (error: Error) => {
			process.umask(previousUmask);
			reject(error);
		};
		server.once('error', onError);
		server.listen(socketPath, () => {
			server.removeListener('error', onError);
			process.umask(previousUmask);
			resolve();
		});
	});
}

function getRpcId(value: unknown): RpcId | null {
	if (typeof value !== 'object' || value === null || !('id' in value)) return null;
	const id = value.id;
	return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)) ? id : null;
}

function getMethod(value: unknown): string | null {
	if (typeof value !== 'object' || value === null || !('method' in value)) return null;
	return typeof value.method === 'string' ? value.method : null;
}

function isFsError(error: unknown, code: string): boolean {
	return typeof error === 'object' && error !== null && 'code' in error && error.code === code;
}
