import { createConnection, type Socket } from 'node:net';
import { StringDecoder } from 'node:string_decoder';
import type { RpcErrorObject, RpcId, RpcMessage, RpcMethod, RpcNotification, RpcParams, RpcRequest, RpcResponse, RpcResults } from './index.ts';
import { isRpcNotification, isRpcResponse, parseRpcMessage } from './index.ts';

export interface RpcClientOptions {
	socketPath?: string;
	maxFrameBytes?: number;
}

export class RpcClientError extends Error {
	readonly code: number;
	readonly data: unknown;

	constructor(error: RpcErrorObject) {
		super(error.message);
		this.name = 'RpcClientError';
		this.code = error.code;
		this.data = error.data;
	}
}

interface PendingRequest {
	resolve(value: unknown): void;
	reject(error: Error): void;
}

type NotificationListener = (notification: RpcNotification) => void;

export class RpcClient {
	readonly socketPath: string;
	readonly maxFrameBytes: number;
	#socket: Socket | null = null;
	#decoder = new StringDecoder('utf8');
	#buffer = '';
	#nextId = 1;
	#pending = new Map<RpcId, PendingRequest>();
	#listeners = new Set<NotificationListener>();
	#connected = false;

	constructor(options: RpcClientOptions = {}) {
		this.socketPath = options.socketPath ?? defaultSocketPath();
		this.maxFrameBytes = options.maxFrameBytes ?? 4 * 1024 * 1024;
	}

	connect(): Promise<void> {
		if (this.#connected) return Promise.resolve();
		if (this.#socket) return Promise.reject(new Error('RPC connection is already in progress'));
		return new Promise((resolve, reject) => {
			const socket = createConnection({ path: this.socketPath });
			this.#socket = socket;
			const onConnect = () => {
				this.#connected = true;
				socket.removeListener('error', onConnectError);
				resolve();
			};
			const onConnectError = (error: Error) => {
				if (!this.#connected) {
					this.#socket = null;
					socket.destroy();
					reject(error);
				}
			};
			socket.once('connect', onConnect);
			socket.on('error', onConnectError);
			socket.on('data', (chunk) => this.#onData(typeof chunk === 'string' ? Buffer.from(chunk) : chunk));
			socket.on('error', (error) => this.#failAll(error));
			socket.on('close', () => {
				this.#connected = false;
				this.#socket = null;
				this.#failAll(new Error('daemon connection closed'));
			});
		});
	}

	request<M extends RpcMethod>(method: M, params: RpcParams[M]): Promise<RpcResults[M]> {
		if (!this.#connected || !this.#socket) return Promise.reject(new Error('RPC client is not connected'));
		const id = this.#nextId++;
		const request: RpcRequest = { jsonrpc: '2.0', id, method, params } as RpcRequest;
		return new Promise<RpcResults[M]>((resolve, reject) => {
			this.#pending.set(id, { resolve: (value) => resolve(value as RpcResults[M]), reject });
			try {
				this.#write(request);
			} catch (error) {
				this.#pending.delete(id);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	}

	onNotification(listener: NotificationListener): () => void {
		this.#listeners.add(listener);
		return () => this.#listeners.delete(listener);
	}

	close(): void {
		this.#connected = false;
		this.#socket?.destroy();
		this.#socket = null;
		this.#failAll(new Error('RPC client closed'));
	}

	#write(message: RpcRequest): void {
		const socket = this.#socket;
		if (!socket || !socket.writable) throw new Error('RPC socket is not writable');
		socket.write(`${JSON.stringify(message)}\n`);
	}

	#onData(chunk: Buffer): void {
		this.#buffer += this.#decoder.write(chunk);
		if (Buffer.byteLength(this.#buffer) > this.maxFrameBytes && !this.#buffer.includes('\n')) {
			this.#socket?.destroy(new Error('RPC frame exceeds configured limit'));
			return;
		}
		for (;;) {
			const newline = this.#buffer.indexOf('\n');
			if (newline === -1) break;
			const line = this.#buffer.slice(0, newline).trim();
			this.#buffer = this.#buffer.slice(newline + 1);
			if (!line) continue;
			if (Buffer.byteLength(line) > this.maxFrameBytes) {
				this.#socket?.destroy(new Error('RPC frame exceeds configured limit'));
				return;
			}
			let message: RpcMessage;
			try {
				message = parseRpcMessage(line);
			} catch (error) {
				this.#socket?.destroy(error instanceof Error ? error : new Error(String(error)));
				return;
			}
			this.#dispatch(message);
		}
	}

	#dispatch(message: RpcMessage): void {
		if (isRpcNotification(message)) {
			for (const listener of this.#listeners) {
				try {
					listener(message);
				} catch {
					// One observer cannot block delivery to other notification listeners.
				}
			}
			return;
		}
		if (!isRpcResponse(message)) {
			this.#socket?.destroy(new Error('daemon sent a non-response JSON-RPC message'));
			return;
		}
		if (message.id === null) return;
		const pending = this.#pending.get(message.id);
		if (!pending) return;
		this.#pending.delete(message.id);
		if ('error' in message) pending.reject(new RpcClientError(message.error));
		else pending.resolve(message.result);
	}

	#failAll(error: Error): void {
		for (const pending of this.#pending.values()) pending.reject(error);
		this.#pending.clear();
	}
}

export function defaultSocketPath(): string {
	const runtimeDirectory = process.env.XDG_RUNTIME_DIR;
	if (!runtimeDirectory) throw new Error('XDG_RUNTIME_DIR is not set; cmdmark requires a user runtime directory');
	return `${runtimeDirectory.replace(/\/$/, '')}/cmdmark.sock`;
}

export function decodeOutput(dataBase64: string): Buffer {
	return Buffer.from(dataBase64, 'base64');
}
