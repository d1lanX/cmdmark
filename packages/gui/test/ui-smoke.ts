import { strict as assert } from 'node:assert';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launch } from 'gpuix-svelte/automation';
import { RpcClient } from '@cmdmark/protocol/client';

const directory = await mkdtemp(join(tmpdir(), 'cmdmark-gui-'));
const runtimeDirectory = join(directory, 'runtime');
const stateDirectory = join(directory, 'state');
await mkdir(runtimeDirectory, { mode: 0o700 });

let app: Awaited<ReturnType<typeof launch>> | null = null;
let client: RpcClient | null = null;
let daemonPid: number | null = null;

try {
	app = await launch({
		entry: 'app.ts',
		bun: true,
		cwd: process.cwd(),
		env: { ...process.env, XDG_RUNTIME_DIR: runtimeDirectory, XDG_STATE_HOME: stateDirectory }
	});
	client = new RpcClient({ socketPath: join(runtimeDirectory, 'cmdmark.sock') });
	await client.connect();
	daemonPid = (await client.request('daemon.ping', {})).pid;

	await app.getByTestId('new-command').click();
	await app.getByTestId('command-name').fill('Native UI smoke');
	await app.getByTestId('command-text').fill('printf "native-ui-output\\n"');
	await app.getByTestId('command-text').wheel(0, -1000);
	await app.getByTestId('save-command').click();
	const command = await waitFor(async () => {
		const result = await client!.request('commands.search', { query: 'Native UI smoke' });
		return result.hits[0]?.command;
	}, 'command editor did not save the bookmark');
	assert.ok(command);
	await app.getByTestId(`command-${command.id}`).bounds();
	await app.getByTestId(`run-${command.id}`).waitFor({ timeoutMs: 5000 });
	await app.getByTestId(`terminal-${command.id}`).bounds();
	await app.getByTestId(`run-${command.id}`).click();
	const run = await waitFor(async () => {
		const result = await client!.request('runs.list', {});
		return result.runs.find((candidate) => candidate.commandId === command.id);
	}, 'run button did not start the bookmark');
	assert.ok(run);
	const row = app!.getByTestId(`run-row-${run.runId}`);
	await clickAndAwait(row.getByText('Logs'), () => app!.getByTestId('log-line-0'), 'first log view');
	assert.match(await app.getByTestId('log-line-0').textContent(), /native-ui-output/);
	await app.getByTestId('settings-navigation').click();
	await app.getByTestId('settings-scroll').wheel(0, -1000);
	const exportPath = join(directory, 'bookmarks.json');
	await app.getByTestId('export-path').fill(exportPath);
	await app.getByTestId('export-bookmarks').click();
	const exported = await readFile(exportPath, 'utf8');
	assert.match(exported, /cmdmark-bookmarks/);

	const importPath = join(directory, 'risky-bookmarks.json');
	await writeFile(importPath, JSON.stringify({
		format: 'cmdmark-bookmarks',
		version: 1,
		commands: [{ name: 'Imported cleanup', command: 'rm -rf /tmp/cmdmark-ui-smoke' }]
	}), { mode: 0o600 });
	await app.getByTestId('import-path').fill(importPath);
	await app.getByTestId('review-import').click();
	await app.getByText('recursive force delete (rm -rf)').waitFor({ timeoutMs: 5000 });
	await app.getByTestId('confirm-import').click();
	const imported = await waitFor(async () => {
		const result = await client!.request('commands.search', { query: 'Imported cleanup' });
		return result.hits[0]?.command;
	}, 'confirmed import was not added');
	assert.equal(imported.name, 'Imported cleanup');
	assert.equal((await client.request('runs.list', {})).runs.length, 1);

	const heldClient = client!;
	const held = await heldClient.request('runs.start', { command: 'sleep 6', shell: '/bin/sh' });
	await waitFor(async () => {
		const result = await heldClient.request('runs.get', { runId: held.run.runId });
		return result.run && result.run.endedAt === null ? result.run : undefined;
	}, 'held run did not start');
	await app.getByTestId('runs-navigation').click();
	await waitFor(async () => {
		try {
			return await app!.getByText('Terminal').bounds();
		} catch {
			return undefined;
		}
	}, 'active-run Terminal button is not painted');

	const followed = await client.request('runs.start', { command: 'seq 1 100', shell: '/bin/sh' });
	await waitFor(async () => {
		const result = await client!.request('runs.get', { runId: followed.run.runId });
		return result.run && result.run.endedAt !== null ? result.run : undefined;
	}, 'streamed log run did not finish');
	const view = app!;
	await view.getByTestId('runs-navigation').click();
	await clickAndAwait(view.getByTestId(`run-row-${followed.run.runId}`).getByText('Logs'), () => view.getByTestId('log-line-99'), 'tail log view');
	await wheelFollow((index) => view.getByTestId(`log-line-${index}`), 600, 'Follow output', 'wheel-up did not disable tail following');
	await view.getByTestId('log-line-70').waitFor({ timeoutMs: 5000 });
	await wheelFollow((index) => view.getByTestId(`log-line-${index}`), -10000, 'Following tail', 'wheel-down did not re-enable tail following');

	await client.request('runs.stop', { runId: held.run.runId, gracePeriodMs: 200 });
	const singleDelete = await client.request('runs.start', { command: 'printf "delete this run\\n"', shell: '/bin/sh' });
	await waitFor(async () => {
		const result = await client!.request('runs.get', { runId: singleDelete.run.runId });
		return result.run && result.run.endedAt !== null ? result.run : undefined;
	}, 'single-delete run did not finish');
	await view.getByTestId('runs-navigation').click();
	await view.getByTestId(`delete-run-${singleDelete.run.runId}`).waitFor({ timeoutMs: 5000 });
	await view.getByTestId(`delete-run-${singleDelete.run.runId}`).click();
	await view.getByTestId('confirm-run-delete').waitFor({ timeoutMs: 5000 });
	await view.getByTestId('confirm-run-delete').click();
	await waitFor(async () => {
		const result = await client!.request('runs.get', { runId: singleDelete.run.runId });
		return result.run === null ? true : undefined;
	}, 'single run was not deleted');
	assert.equal(await Bun.file(singleDelete.run.logPath).exists(), false);

	await view.getByTestId('clear-run-history').waitFor({ timeoutMs: 5000 });
	await view.getByTestId('clear-run-history').click();
	await view.getByTestId('confirm-run-delete').waitFor({ timeoutMs: 5000 });
	await view.getByTestId('confirm-run-delete').click();
	await waitFor(async () => {
		const result = await client!.request('runs.list', {});
		return result.runs.length === 0 ? result.runs : undefined;
	}, 'completed run history was not cleared');

	console.log(JSON.stringify({ platform: process.platform, bun: Bun.version, command: command.name, imported: imported.name, follow: 'PASS', runState: (await client.request('runs.get', { runId: run.runId })).run?.state, ui: 'PASS' }));
} finally {
	if (app) await app.close();
	client?.close();
	if (daemonPid !== null) {
		try { process.kill(daemonPid, 'SIGTERM'); } catch {}
		await waitForSocketGone(join(runtimeDirectory, 'cmdmark.sock'));
	}
	await rm(directory, { recursive: true, force: true });
}

/**
 * A real-window click can be swallowed while the renderer is mid-paint, so for navigation clicks
 * whose result is a visible element, poll: click, give the element a moment, click again.
 */
async function clickAndAwait(trigger: { click: () => Promise<unknown> }, done: () => { waitFor: (options: { timeoutMs: number }) => Promise<unknown> }, message: string): Promise<void> {
	const deadline = Date.now() + 8000;
	let lastError: unknown = null;
	while (Date.now() < deadline) {
		await trigger.click();
		try {
			await done().waitFor({ timeoutMs: 1200 });
			return;
		} catch (error) {
			if (!(error instanceof Error) || !(error as Error).message.includes('waitFor timed out')) {
				lastError = error;
				break;
			}
		}
	}
	throw lastError ?? new Error(message);
}

/**
 * A real-window wheel can be swallowed at a stale hit-test point, and virtual rows outside the
 * realized range have no painted bounds, so walk a spread of rows and repeat the scroll on the
 * first one that can take it, until the follow toggle reflects the position.
 */
async function wheelFollow(pick: (index: number) => { wheel: (x: number, y: number) => Promise<unknown> }, dy: number, expected: string, message: string): Promise<void> {
	const deadline = Date.now() + 8000;
	let last: string | null = null;
	while (Date.now() < deadline) {
		for (const index of [99, 97, 95, 93, 90, 85, 80, 75, 70, 60, 50]) {
			try {
				await pick(index).wheel(0, dy);
			} catch {
				continue;
			}
			const settleAt = Date.now() + 700;
			while (Date.now() < settleAt) {
				try {
					last = await app!.getByTestId('follow-toggle').textContent();
				} catch {}
				if (last === expected) return;
				await Bun.sleep(40);
			}
		}
	}
	throw new Error(`${message} (toggle still: ${last})`);
}

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, message: string): Promise<T> {	const deadline = Date.now() + 5000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error(message);
}

async function waitForSocketGone(path: string): Promise<void> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		if (!(await Bun.file(path).exists())) return;
		await Bun.sleep(20);
	}
}
