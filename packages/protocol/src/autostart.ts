import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join } from 'node:path';
import type { RpcClient } from './client.ts';

export interface DaemonLaunchSpec {
	command: string;
	args: string[];
	cwd?: string;
}

export interface ConnectOrStartOptions {
	timeoutMs?: number;
	retryIntervalMs?: number;
}

export function defaultDaemonLaunchSpec(sourceEntry?: string): DaemonLaunchSpec {
	const cli = defaultCliLaunchSpec(sourceEntry);
	return { ...cli, args: [...cli.args, 'daemon', '--foreground'] };
}

/** The same executable/source entry, without the daemon subcommand. */
export function defaultCliLaunchSpec(sourceEntry?: string): DaemonLaunchSpec {
	const configured = process.env.CMDMARK_BIN;
	if (configured) return { command: configured, args: [] };

	const candidate = sourceEntry ?? process.argv[1];
	const runtimeName = basename(process.execPath).toLocaleLowerCase();
	const runningOnBunRuntime = runtimeName === 'bun' || runtimeName === 'bun.exe';
	if (runningOnBunRuntime && candidate && /\.(?:ts|[cm]?js)$/.test(candidate) && existsSync(candidate)) {
		return { command: process.execPath, args: [candidate], cwd: process.cwd() };
	}

	const sibling = join(dirname(process.execPath), 'cmdmark');
	if (existsSync(sibling)) return { command: sibling, args: [] };
	if (basename(process.execPath) === 'cmdmark') return { command: process.execPath, args: [] };
	return { command: 'cmdmark', args: [] };
}

export function spawnDaemonProcess(spec: DaemonLaunchSpec): Promise<void> {
	return new Promise((resolve, reject) => {
		const child = spawn(spec.command, spec.args, {
			cwd: spec.cwd,
			env: process.env,
			stdio: 'ignore',
			detached: true
		});
		child.once('spawn', () => {
			child.unref();
			resolve();
		});
		child.once('error', reject);
	});
}

export async function connectOrStartDaemon(
	client: RpcClient,
	startDaemon: () => void | Promise<void>,
	options: ConnectOrStartOptions = {}
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const retryIntervalMs = options.retryIntervalMs ?? 100;
	try {
		await client.connect();
		return;
	} catch {
		// Start the daemon only when the first connection is absent or refused.
	}
	try {
		await startDaemon();
	} catch {
		// Another client may have won the startup race, or the binary may be unavailable.
	}
	const deadline = Date.now() + timeoutMs;
	let lastError: unknown;
	while (Date.now() < deadline) {
		await delay(retryIntervalMs);
		try {
			await client.connect();
			return;
		} catch (error) {
			lastError = error;
		}
	}
	throw new Error('could not connect to cmdmarkd after starting it', { cause: lastError });
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
