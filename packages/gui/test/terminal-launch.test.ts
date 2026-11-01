import { afterEach, describe, expect, test } from 'bun:test';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchTerminal } from '../src/terminal.ts';

describe('launchTerminal', () => {
	let directory: string | undefined;

	afterEach(async () => {
		if (directory) await rm(directory, { recursive: true, force: true });
		directory = undefined;
	});

	test('uses terminator argv syntax and invokes the source CLI attach command', async () => {
		directory = await mkdtemp(join(tmpdir(), 'cmdmark-terminal-'));
		const executable = join(directory, 'terminator');
		const capture = join(directory, 'args.txt');
		await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' "$@" > '${capture}'\n`);
		await chmod(executable, 0o755);

		await launchTerminal('run-123', executable);
		const argsText = await waitFor(async () => {
			try { return await readFile(capture, 'utf8'); } catch { return undefined; }
		}, 'terminal emulator did not receive command arguments');
		const args = argsText.trim().split('\n');

		expect(args[0]).toBe('-x');
		expect(args.at(-2)).toBe('attach');
		expect(args.at(-1)).toBe('run-123');
		expect(args.some((arg) => arg.endsWith('/packages/cli/src/main.ts'))).toBe(true);
	});
});

async function waitFor<T>(read: () => T | undefined | Promise<T | undefined>, message: string): Promise<T> {
	const deadline = Date.now() + 3000;
	while (Date.now() < deadline) {
		const value = await read();
		if (value !== undefined) return value;
		await Bun.sleep(20);
	}
	throw new Error(message);
}
