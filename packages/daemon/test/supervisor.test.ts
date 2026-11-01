import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandStore } from '../src/store.ts';
import { ProcessSupervisor } from '../src/supervisor.ts';

describe('ProcessSupervisor', () => {
	let directory: string;
	let store: CommandStore;
	let supervisor: ProcessSupervisor;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'cmdmark-supervisor-'));
		store = new CommandStore(join(directory, 'cmdmark.sqlite'));
		supervisor = new ProcessSupervisor({
			store,
			logDirectory: join(directory, 'logs'),
			bufferSizeBytes: 4096,
			gracePeriodMs: 150
		});
	});

	afterEach(async () => {
		await supervisor.shutdown();
		store.close();
		await rm(directory, { recursive: true, force: true });
	});

	test('spawns with a PTY, records exit details, and appends a private log', async () => {
		const run = await supervisor.start({ resolvedCommand: 'printf "cmdmark-output\\n"; exit 7', shell: '/bin/sh' });
		const exited = await waitForRun(store, run.runId, (candidate) => candidate.endedAt !== null);
		const logs = await supervisor.readLogs(run.runId);
		const file = await stat(run.logPath);

		expect(exited.state).toBe('exited');
		expect(exited.exitCode).toBe(7);
		expect(exited.pid).toBeGreaterThan(0);
		expect(exited.pgid).toBe(exited.pid);
		expect(exited.procStartTime).toBeTruthy();
		expect(logs.data.toString()).toContain('cmdmark-output');
		expect(file.size).toBeGreaterThan(0);
		expect(file.mode & 0o777).toBe(0o600);
	});

	test('SIGTERM stop kills child processes in the process group', async () => {
		const run = await supervisor.start({
			resolvedCommand: 'sleep 100 & echo CHILD=$!; wait',
			shell: '/bin/sh'
		});
		const childPid = await waitForChildPid(supervisor, run.runId);
		const stopped = await supervisor.stop(run.runId, 500);
		const childState = Bun.spawnSync(['ps', '-o', 'stat=', '-p', String(childPid)]).stdout.toString().trim();

		expect(stopped.state).toBe('stopped');
		expect(stopped.signal).toBe('SIGTERM');
		expect(childState === '' || childState.startsWith('Z')).toBe(true);
	});

	test('escalates from SIGTERM to SIGKILL when the command ignores TERM', async () => {
		const run = await supervisor.start({ resolvedCommand: "trap '' TERM; printf 'READY\\n'; exec sleep 100", shell: '/bin/sh' });
		await waitForLogText(supervisor, run.runId, 'READY');
		const killed = await supervisor.stop(run.runId, 100);

		expect(killed.state).toBe('killed');
		expect(killed.signal).toBe('SIGKILL');
		expect(killed.endedAt).not.toBeNull();
	});

	test('pauses, resumes, and restarts under a new run id', async () => {
		const bookmark = store.createCommand({ name: 'quick', command: 'sleep 100', shell: '/bin/sh' });
		const run = await supervisor.start({
			commandId: bookmark.id,
			resolvedCommand: bookmark.command,
			shell: bookmark.shell,
			env: bookmark.env
		});
		const paused = await supervisor.signal(run.runId, 'SIGSTOP');
		expect(paused).toMatchObject({ state: 'stopped', endedAt: null, signal: 'SIGSTOP' });

		const resumed = await supervisor.signal(run.runId, 'SIGCONT');
		expect(resumed).toMatchObject({ state: 'running', endedAt: null, signal: null });
		await supervisor.stop(run.runId, 300);

		const second = await supervisor.restart(run.runId);
		const restarted = await waitForRun(store, second.runId, (candidate) => candidate.state === 'running');
		expect(second.runId).not.toBe(run.runId);
		expect(second.resolvedCommand).toBe(run.resolvedCommand);
		expect(restarted.state).toBe('running');
		expect(restarted.commandId).toBe(bookmark.id);
		await supervisor.stop(second.runId, 300);
	});

	test('clears completed run history and refuses to delete active processes', async () => {
		const completed = await supervisor.start({ resolvedCommand: 'printf history', shell: '/bin/sh' });
		await waitForRun(store, completed.runId, (run) => run.endedAt !== null);
		const active = await supervisor.start({ resolvedCommand: 'sleep 100', shell: '/bin/sh' });

		await expect(supervisor.deleteRun(active.runId)).rejects.toThrow('stop the run before deleting its history');
		const cleared = await supervisor.clearHistory();
		expect(cleared.deletedRunIds).toEqual([completed.runId]);
		expect(cleared.failedRunIds).toEqual([]);
		expect(store.getRun(completed.runId)).toBeNull();
		expect(await Bun.file(completed.logPath).exists()).toBe(false);
		expect(store.getRun(active.runId)).not.toBeNull();

		await supervisor.stop(active.runId, 300);
		expect(await supervisor.deleteRun(active.runId)).toBe(true);
		expect(store.getRun(active.runId)).toBeNull();
		expect(await Bun.file(active.logPath).exists()).toBe(false);
	});
});

async function waitForRun(
	store: CommandStore,
	runId: string,
	predicate: (run: NonNullable<ReturnType<CommandStore['getRun']>>) => boolean
) {
	return waitUntil(() => {
		const run = store.getRun(runId);
		return run && predicate(run) ? run : undefined;
	}, `run ${runId} did not reach the expected state`);
}

async function waitForChildPid(supervisor: ProcessSupervisor, runId: string): Promise<number> {
	return waitUntil(async () => {
		const logs = await supervisor.readLogs(runId);
		const match = logs.data.toString().match(/CHILD=(\d+)/);
		return match ? Number(match[1]) : undefined;
	}, `run ${runId} did not print its child PID`);
}

async function waitForLogText(supervisor: ProcessSupervisor, runId: string, text: string): Promise<void> {
	await waitUntil(async () => {
		const logs = await supervisor.readLogs(runId);
		return logs.data.toString().includes(text) ? true : undefined;
	}, `run ${runId} did not write ${text}`);
}

async function waitUntil<T>(read: () => T | undefined | Promise<T | undefined>, message: string): Promise<T> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(10);
	}
	throw new Error(message);
}
