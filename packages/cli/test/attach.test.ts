import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RpcClient } from '@cmdmark/protocol/client';
import { CommandStore, DaemonSocketServer, ProcessSupervisor } from '@cmdmark/daemon';

describe('cmdmark attach', () => {
	test('prints saved output when a short run finishes before its terminal attaches', async () => {
		const directory = await mkdtemp(join(tmpdir(), 'cmdmark-attach-'));
		const runtimeDirectory = join(directory, 'runtime');
		await mkdir(runtimeDirectory, { mode: 0o700 });
		const store = new CommandStore(join(directory, 'cmdmark.sqlite'));
		const supervisor = new ProcessSupervisor({ store, logDirectory: join(directory, 'logs') });
		const server = new DaemonSocketServer({
			store,
			supervisor,
			socketPath: join(runtimeDirectory, 'cmdmark.sock')
		});
		await server.start();
		const client = new RpcClient({ socketPath: server.socketPath });
		await client.connect();
		try {
			const started = await client.request('runs.start', { command: 'printf "DONE_OUTPUT\\n"', shell: '/bin/sh' });
			await waitFor(async () => {
				const { run } = await client.request('runs.get', { runId: started.run.runId });
				return run && run.endedAt !== null ? run : undefined;
			}, 'short run did not finish');

			let output = '';
			const cliEntry = resolve('packages/cli/src/main.ts');
			const attach = Bun.spawn([process.execPath, cliEntry, 'attach', started.run.runId], {
				env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory, XDG_STATE_HOME: join(directory, 'state') },
				terminal: { cols: 80, rows: 24, data: (_terminal, chunk) => (output += chunk.toString()) }
			});
			const exitCode = await attach.exited;

			expect(exitCode).toBe(0);
			expect(output).toContain('DONE_OUTPUT');
		} finally {
			client.close();
			await server.close();
			await supervisor.shutdown();
			store.close();
			await rm(directory, { recursive: true, force: true });
		}
	});
});

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, message: string): Promise<T> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error(message);
}
