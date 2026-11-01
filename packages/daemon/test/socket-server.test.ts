import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RpcClient, RpcClientError } from '@cmdmark/protocol/client';
import type { RpcNotification } from '@cmdmark/protocol';
import { CommandStore } from '../src/store.ts';
import { DaemonSocketServer } from '../src/socket-server.ts';
import { ProcessSupervisor } from '../src/supervisor.ts';

describe('DaemonSocketServer', () => {
	let directory: string;
	let store: CommandStore;
	let supervisor: ProcessSupervisor;
	let server: DaemonSocketServer;
	let first: RpcClient;
	let second: RpcClient;

	beforeEach(async () => {
		directory = await mkdtemp(join(tmpdir(), 'cmdmark-rpc-'));
		const runtimeDirectory = join(directory, 'runtime');
		await mkdir(runtimeDirectory, { mode: 0o700 });
		store = new CommandStore(join(directory, 'cmdmark.sqlite'));
		supervisor = new ProcessSupervisor({ store, logDirectory: join(directory, 'logs'), gracePeriodMs: 150 });
		server = new DaemonSocketServer({ store, supervisor, socketPath: join(runtimeDirectory, 'cmdmark.sock') });
		await server.start();
		first = new RpcClient({ socketPath: server.socketPath });
		second = new RpcClient({ socketPath: server.socketPath });
		await Promise.all([first.connect(), second.connect()]);
	});

	afterEach(async () => {
		first?.close();
		second?.close();
		await server.close();
		await supervisor.shutdown();
		store.close();
		await rm(directory, { recursive: true, force: true });
	});

	test('sets a same-user socket mode and serves JSON-RPC CRUD/search', async () => {
		const socket = await stat(server.socketPath);
		const ping = await first.request('daemon.ping', {});
		const created = await first.request('commands.create', {
			command: { name: 'Build', command: 'bun run build', tags: ['dev'] }
		});
		const search = await first.request('commands.search', { query: 'build' });

		expect(socket.mode & 0o777).toBe(0o600);
		expect(ping.pid).toBe(process.pid);
		expect(created.command.name).toBe('Build');
		expect(search.hits[0]?.command.id).toBe(created.command.id);
	});

	test('previews risky imports, confirms them separately, and never auto-runs', async () => {
		const json = JSON.stringify({
			format: 'cmdmark-bookmarks',
			version: 1,
			commands: [{ name: 'Dangerous cleanup', command: 'rm -rf /tmp/build' }]
		});
		const preview = await first.request('commands.importPreview', { json });
		const before = await first.request('commands.list', {});
		const imported = await first.request('commands.import', { commands: preview.commands });
		const runs = await first.request('runs.list', {});

		expect(preview.risks[0]?.patterns).toContain('recursive force delete (rm -rf)');
		expect(before.commands).toHaveLength(0);
		expect(imported.commands[0]?.name).toBe('Dangerous cleanup');
		expect(imported.risks).toHaveLength(1);
		expect(runs.runs).toHaveLength(0);
	});

	test('streams logs and enforces one interactive attach writer per run', async () => {
		const notifications: RpcNotification[] = [];
		const unsubscribe = first.onNotification((notification) => notifications.push(notification));
		const started = await first.request('runs.start', {
			command: 'read value; stty size; printf "got:%s\\n" "$value"',
			shell: '/bin/sh'
		});
		const attached = await first.request('runs.attach', { runId: started.run.runId, cols: 100, rows: 40 });

		expect(attached.attached).toBe(true);
		let attachError: unknown;
		try {
			await second.request('runs.attach', { runId: started.run.runId, cols: 80, rows: 24 });
		} catch (error) {
			attachError = error;
		}
		expect(attachError).toBeInstanceOf(RpcClientError);
		expect((attachError as RpcClientError | undefined)?.code).toBe(-32010);
		await first.request('runs.write', { runId: started.run.runId, dataBase64: Buffer.from('hello\n').toString('base64') });
		const output = await waitForOutput(notifications, started.run.runId, 'got:hello');
		const run = await first.request('runs.get', { runId: started.run.runId });

		expect(output).toContain('40 100');
		expect(run.run?.state).toBe('exited');
		await first.request('runs.detach', { runId: started.run.runId });
		unsubscribe();
	});

	test('releases an attach owner when its socket disconnects', async () => {
		const started = await first.request('runs.start', { command: 'sleep 100', shell: '/bin/sh' });
		await first.request('runs.attach', { runId: started.run.runId, cols: 80, rows: 24 });
		first.close();
		await waitUntil(async () => {
			try {
				const attached = await second.request('runs.attach', { runId: started.run.runId, cols: 80, rows: 24 });
				return attached.attached;
			} catch (error) {
				if (error instanceof RpcClientError && error.code === -32010) return undefined;
				throw error;
			}
		}, 'second client did not acquire the released attach');
		await second.request('runs.detach', { runId: started.run.runId });
		await second.request('runs.stop', { runId: started.run.runId, gracePeriodMs: 100 });
	});

	test('deletes one completed run or clears completed history, never active runs', async () => {
		const notifications: RpcNotification[] = [];
		const unsubscribe = second.onNotification((notification) => notifications.push(notification));
		const completed = await first.request('runs.start', { command: 'printf "delete me"', shell: '/bin/sh' });
		await waitUntil(async () => {
			const { run } = await first.request('runs.get', { runId: completed.run.runId });
			return run && run.endedAt !== null ? run : undefined;
		}, 'run to delete did not finish');

		const deleted = await first.request('runs.delete', { runId: completed.run.runId });
		expect(deleted.deleted).toBe(true);
		expect((await first.request('runs.get', { runId: completed.run.runId })).run).toBeNull();
		await waitUntil(() => notifications.some((notification) =>
			notification.method === 'runs.deleted' && notification.params.runIds.includes(completed.run.runId)
		) ? true : undefined, 'run deletion notification was not broadcast');

		const active = await first.request('runs.start', { command: 'sleep 100', shell: '/bin/sh' });
		let activeDeleteError: unknown;
		try {
			await first.request('runs.delete', { runId: active.run.runId });
		} catch (error) {
			activeDeleteError = error;
		}
		expect(activeDeleteError).toBeInstanceOf(RpcClientError);
		expect((activeDeleteError as RpcClientError | undefined)?.code).toBe(-32009);
		await first.request('runs.stop', { runId: active.run.runId, gracePeriodMs: 100 });

		const other = await first.request('runs.start', { command: 'printf "clear me"', shell: '/bin/sh' });
		await waitUntil(async () => {
			const { run } = await first.request('runs.get', { runId: other.run.runId });
			return run && run.endedAt !== null ? run : undefined;
		}, 'run to clear did not finish');
		const cleared = await first.request('runs.clearHistory', {});
		expect(cleared.deletedRunIds).toContain(active.run.runId);
		expect(cleared.deletedRunIds).toContain(other.run.runId);
		expect(cleared.failedRunIds).toEqual([]);
		expect((await first.request('runs.list', {})).runs).toHaveLength(0);
		unsubscribe();
	});
});

async function waitForOutput(notifications: RpcNotification[], runId: string, text: string): Promise<string> {
	return waitUntil(() => {
		const chunks = notifications
			.flatMap((notification) => notification.method === 'run.output' && notification.params.runId === runId
				? [Buffer.from(notification.params.dataBase64, 'base64').toString()]
				: [])
			.join('');
		return chunks.includes(text) ? chunks : undefined;
	}, `run ${runId} did not produce ${text}`);
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
