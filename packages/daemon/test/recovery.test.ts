import { afterEach, describe, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CommandStore } from '../src/store.ts';
import { BunPtyBackend } from '../src/pty.ts';
import { recoverOrphanedRuns } from '../src/daemon.ts';

describe('daemon restart recovery', () => {
	let directory: string | undefined;
	let store: CommandStore | undefined;
	let backend: BunPtyBackend | undefined;

	afterEach(async () => {
		for (const process of backend?.list() ?? []) await backend!.kill(process.runId, 'SIGKILL');
		store?.close();
		if (directory) await rm(directory, { recursive: true, force: true });
		directory = undefined;
		store = undefined;
		backend = undefined;
	});

	test('kills a leftover process group and marks its run lost', async () => {
		directory = await mkdtemp(join(tmpdir(), 'cmdmark-recovery-'));
		store = new CommandStore(join(directory, 'db.sqlite'));
		backend = new BunPtyBackend();
		const runId = randomUUID();
		store.createRun({ runId, resolvedCommand: 'sleep 100 & wait', state: 'running', logPath: join(directory, 'run.log') });
		let resolveExit!: () => void;
		const exited = new Promise<void>((resolve) => (resolveExit = resolve));
		const descriptor = backend.spawn({
			runId,
			shell: '/bin/sh',
			command: 'sleep 100 & wait',
			cwd: null,
			env: processEnvironment(),
			cols: 80,
			rows: 24,
			onData: () => {},
			onExit: () => resolveExit()
		});
		store.updateRun(runId, {
			pid: descriptor.pid,
			pgid: descriptor.pgid,
			procStartTime: descriptor.procStartTime
		});

		expect(await recoverOrphanedRuns(store, 300)).toBe(1);
		await exited;
		expect(store.getRun(runId)).toMatchObject({ state: 'lost', endedAt: expect.any(Number) });
		expect(backend.list()).toHaveLength(0);
	});
});

function processEnvironment(): Record<string, string> {
	return Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}
