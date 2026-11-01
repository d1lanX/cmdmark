import { chmod, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { RunRecord } from '@cmdmark/protocol';
import { CommandStore } from './store.ts';
import { processGroupExists, signalProcessGroupSafely, type ProcessDescriptor } from './pty.ts';
import { DaemonSocketServer } from './socket-server.ts';
import { ProcessSupervisor } from './supervisor.ts';
import { resolveDaemonPaths } from './paths.ts';

export interface RunDaemonOptions {
	socketPath?: string;
	stateDirectory?: string;
	logDirectory?: string;
	shutdownGracePeriodMs?: number;
}

export async function recoverOrphanedRuns(store: CommandStore, gracePeriodMs = 5000): Promise<number> {
	const candidates = store.listRuns().filter(isOrphanCandidate);
	await Promise.all(candidates.map(async (run) => {
		await terminateOrphan(run, gracePeriodMs);
		store.updateRun(run.runId, { state: 'lost', endedAt: Date.now() });
	}));
	return candidates.length;
}

export async function runDaemon(options: RunDaemonOptions = {}): Promise<void> {
	const paths = resolveDaemonPaths();
	const stateDirectory = options.stateDirectory ?? paths.stateDirectory;
	const logDirectory = options.logDirectory ?? paths.logDirectory;
	const socketPath = options.socketPath ?? paths.socketPath;
	await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
	await chmod(stateDirectory, 0o700);
	await mkdir(logDirectory, { recursive: true, mode: 0o700 });
	await chmod(logDirectory, 0o700);

	const store = new CommandStore(join(stateDirectory, 'cmdmark.sqlite'), { defaultShell: process.env.SHELL || '/bin/sh' });
	const settings = store.getSettings();
	const supervisor = new ProcessSupervisor({
		store,
		logDirectory,
		bufferSizeBytes: settings.bufferSizeBytes,
		gracePeriodMs: options.shutdownGracePeriodMs ?? settings.gracePeriodMs
	});
	const server = new DaemonSocketServer({ store, supervisor, socketPath });

	try {
		await recoverOrphanedRuns(store, settings.gracePeriodMs);
		await server.start();
		process.stderr.write(`[cmdmarkd] listening on ${socketPath}\n`);
		await waitForShutdown(server, supervisor, store);
	} catch (error) {
		try {
			await server.close();
		} finally {
			store.close();
		}
		throw error;
	}
}

function isOrphanCandidate(run: RunRecord): boolean {
	return run.state === 'starting' || run.state === 'running' || (run.state === 'stopped' && run.endedAt === null);
}

async function terminateOrphan(run: RunRecord, gracePeriodMs: number): Promise<void> {
	if (run.pid === null || run.pgid === null || run.procStartTime === null) return;
	const descriptor: ProcessDescriptor = {
		runId: run.runId,
		pid: run.pid,
		pgid: run.pgid,
		procStartTime: run.procStartTime
	};
	try {
		if (!signalProcessGroupSafely(descriptor, 'SIGTERM')) return;
		const deadline = Date.now() + Math.max(0, gracePeriodMs);
		while (Date.now() < deadline && processGroupExists(descriptor)) await delay(25);
		if (processGroupExists(descriptor)) signalProcessGroupSafely(descriptor, 'SIGKILL');
	} catch (error) {
		process.stderr.write(`[cmdmarkd] could not clean up old process group ${run.pgid}: ${String(error)}\n`);
	}
}

async function waitForShutdown(server: DaemonSocketServer, supervisor: ProcessSupervisor, store: CommandStore): Promise<void> {
	await new Promise<void>((resolve) => {
		let shuttingDown = false;
		const onSignal = () => {
			if (shuttingDown) return;
			shuttingDown = true;
			void (async () => {
				try {
					await server.close();
					await supervisor.shutdown();
				} catch (error) {
					process.stderr.write(`[cmdmarkd] shutdown error: ${String(error)}\n`);
				} finally {
					store.close();
					process.off('SIGINT', onSignal);
					process.off('SIGTERM', onSignal);
					resolve();
				}
			})();
		};
		process.once('SIGINT', onSignal);
		process.once('SIGTERM', onSignal);
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
