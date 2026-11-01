import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RpcClient } from '@cmdmark/protocol/client';

describe('CLI daemon autostart', () => {
	let directory: string | undefined;
	let daemonPid: number | undefined;
	let client: RpcClient | undefined;

	afterEach(async () => {
		client?.close();
		if (daemonPid) {
			try { process.kill(daemonPid, 'SIGTERM'); } catch {}
			await waitForSocketGone(directory ? join(directory, 'runtime', 'cmdmark.sock') : '');
		}
		if (directory) await rm(directory, { recursive: true, force: true });
		directory = undefined;
		daemonPid = undefined;
		client = undefined;
	});

	test('starts cmdmarkd on demand and leaves it running after the CLI exits', async () => {
		directory = await mkdtemp(join(tmpdir(), 'cmdmark-autostart-'));
		const runtimeDirectory = join(directory, 'runtime');
		const stateDirectory = join(directory, 'state');
		await mkdir(runtimeDirectory, { mode: 0o700 });
		const entry = resolve('packages/cli/src/main.ts');
		const cli = Bun.spawn([process.execPath, entry, 'list'], {
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory, XDG_STATE_HOME: stateDirectory }
		});
		const stdout = await new Response(cli.stdout).text();
		const stderr = await new Response(cli.stderr).text();
		const exitCode = await cli.exited;
		const socketPath = join(runtimeDirectory, 'cmdmark.sock');
		const socket = await stat(socketPath);
		client = new RpcClient({ socketPath });
		await client.connect();
		const ping = await client.request('daemon.ping', {});
		daemonPid = ping.pid;
		const { command } = await client.request('commands.create', {
			command: { name: 'Template run', command: 'printf "VALUE:%s\\n" {{label}}', shell: '/bin/sh', params: [{ name: 'label', promptLabel: 'Label' }] }
		});
		const runCli = Bun.spawn([process.execPath, entry, 'run', command.id, '--param', "label=O'Reilly"], {
			stdin: 'ignore',
			stdout: 'pipe',
			stderr: 'pipe',
			env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory, XDG_STATE_HOME: stateDirectory }
		});
		const runId = (await new Response(runCli.stdout).text()).trim();
		const runError = await new Response(runCli.stderr).text();
		const runExitCode = await runCli.exited;
		const completedRun = await waitFor(async () => {
			const result = await client!.request('runs.get', { runId });
			return result.run && result.run.endedAt !== null ? result.run : undefined;
		}, 'CLI template command did not finish');
		const logs = await client.request('runs.logs', { runId });

		expect(exitCode).toBe(0);
		expect(stdout).toBe('');
		expect(stderr).toBe('');
		expect(socket.mode & 0o777).toBe(0o600);
		expect(ping.pid).toBeGreaterThan(0);
		expect(await Bun.file(join(stateDirectory, 'cmdmark', 'cmdmark.sqlite')).exists()).toBe(true);
		expect(runExitCode).toBe(0);
		expect(runError).toBe('');
		expect(completedRun.state).toBe('exited');
		expect(Buffer.from(logs.dataBase64, 'base64').toString()).toContain("VALUE:O'Reilly");
	});
});

async function waitForSocketGone(path: string): Promise<void> {
	if (!path) return;
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (!(await Bun.file(path).exists())) return;
		await Bun.sleep(20);
	}
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, message: string): Promise<T> {
	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error(message);
}
