import { basename } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { runDaemon } from '@cmdmark/daemon';
import { RpcClient, decodeOutput } from '@cmdmark/protocol/client';
import { connectOrStartDaemon, defaultDaemonLaunchSpec, spawnDaemonProcess } from '@cmdmark/protocol/autostart';
import type { RpcNotification, RunRecord } from '@cmdmark/protocol';
import { resolveTemplate, templateVariables } from '@cmdmark/protocol/template';

const DETACH_KEY = 'ctrl-]';

async function main(): Promise<void> {
	const args = commandLineArguments();
    const executableName = basename(process.execPath || process.argv[0] || 'cmdmark');
	const [command, ...rest] = args;

	if (command === 'daemon' || (executableName === 'cmdmarkd' && command === undefined)) {
		await runDaemon();
		return;
	}
	if (command === '--version' || command === '-v') {
		process.stdout.write('cmdmark 0.1.0\n');
		return;
	}
	if (!command || command === 'help' || command === '--help' || command === '-h') {
		printUsage();
		return;
	}

	const client = new RpcClient();
	await connectOrStartDaemon(client, () => spawnDaemonProcess(defaultDaemonLaunchSpec()));
	try {
		await runCommand(client, command, rest);
	} finally {
		client.close();
	}
}

async function runCommand(client: RpcClient, command: string, args: string[]): Promise<void> {
	switch (command) {
		case 'add': {
			const separator = args.indexOf('--');
			if (separator < 1 || separator === args.length - 1) throw new Error('usage: cmdmark add <name> -- <shell command>');
			const name = args.slice(0, separator).join(' ').trim();
			const shellCommand = args.slice(separator + 1).join(' ').trim();
			const { command: created } = await client.request('commands.create', { command: { name, command: shellCommand } });
			process.stdout.write(`${created.id}\t${created.name}\n`);
			return;
		}
		case 'list': {
			const { commands } = await client.request('commands.list', {});
			for (const bookmark of commands) {
				const star = bookmark.favorite ? '★' : ' ';
				process.stdout.write(`${star}\t${bookmark.id}\t${bookmark.name}\t${bookmark.command}\n`);
			}
			return;
		}
		case 'search': {
			const query = args.join(' ').trim();
			const { hits } = await client.request('commands.search', { query });
			for (const hit of hits) process.stdout.write(`${hit.command.id}\t${hit.score.toFixed(3)}\t${hit.command.name}\t${hit.command.command}\n`);
			return;
		}
        case 'run': {
            const separator = args.indexOf('--');
            let request: { commandId?: string; command: string; cwd?: string | null; shell?: string; env?: Record<string, string> };
            if (separator === 0) {
                const template = args.slice(1).join(' ').trim();
                if (!template) throw new Error('ad-hoc command is required after --');
                const values = await collectTemplateValues(template, [], {});
                request = { command: resolveTemplate(template, values) };
            } else {
                const commandId = args[0];
                if (!commandId) throw new Error('usage: cmdmark run <command_id> [--param name=value] | cmdmark run -- <shell command>');
                const { command: bookmark } = await client.request('commands.get', { id: commandId });
                if (!bookmark) throw new Error(`command not found: ${commandId}`);
                const provided = parseParameterOptions(args.slice(1));
                const values = await collectTemplateValues(bookmark.command, bookmark.params, provided);
                request = {
                    commandId,
                    command: resolveTemplate(bookmark.command, values, bookmark.params),
                    cwd: bookmark.cwd,
                    shell: bookmark.shell,
                    env: bookmark.env
                };
            }
            const { run } = await client.request('runs.start', request);
            process.stdout.write(`${run.runId}\n`);
            return;
		}
		case 'ps': {
			const { runs } = await client.request('runs.list', {});
			for (const run of runs) printRun(run);
			return;
		}
		case 'stop':
		case 'kill': {
			const runId = args[0];
			if (!runId) throw new Error(`usage: cmdmark ${command} <run_id>`);
			const { run } = command === 'stop'
				? await client.request('runs.stop', { runId })
				: await client.request('runs.signal', { runId, signal: 'SIGKILL' });
			process.stdout.write(`${run.runId}\t${run.state}\n`);
			return;
		}
		case 'logs':
			await showLogs(client, args);
			return;
		case 'attach':
			await attach(client, args[0]);
			return;
		default:
			throw new Error(`unknown command: ${command}`);
	}
}

async function showLogs(client: RpcClient, args: string[]): Promise<void> {
	const runId = args[0];
	if (!runId) throw new Error('usage: cmdmark logs <run_id> [--follow]');
	const follow = args.includes('--follow');
	const queued: RpcNotification[] = [];
	let ready = false;
	let cursor = 0;
	let finished = false;
	let resolveFinished: (() => void) | undefined;
	const finishedPromise = new Promise<void>((resolve) => (resolveFinished = resolve));
	const onNotification = client.onNotification((notification) => {
		if (notification.method === 'run.state' && notification.params.run.runId === runId) {
			if (notification.params.run.endedAt !== null) {
				finished = true;
				resolveFinished?.();
			}
		}
		if (notification.method === 'run.output' && notification.params.runId === runId) {
			if (!ready) queued.push(notification);
			else cursor = writeOutputChunk(notification, cursor);
		}
	});
	let subscriptionId: string | undefined;
	if (follow) {
		subscriptionId = (await client.request('runs.subscribe', { runId, includeOutput: true })).subscriptionId;
		const existing = await client.request('runs.get', { runId });
		finished = existing.run?.endedAt !== null && existing.run !== null;
	}
	try {
		const logs = await client.request('runs.logs', { runId });
		const initial = decodeOutput(logs.dataBase64);
		process.stdout.write(initial);
		cursor = logs.nextOffset;
		ready = true;
		queued.sort((left, right) => outputOffset(left) - outputOffset(right));
		for (const notification of queued) cursor = writeOutputChunk(notification, cursor);
		queued.length = 0;
		if (follow && !finished) await finishedPromise;
	} finally {
		onNotification();
		if (subscriptionId) await client.request('runs.unsubscribe', { subscriptionId }).catch(() => {});
	}
}

async function attach(client: RpcClient, runId: string | undefined): Promise<void> {
	if (!runId) throw new Error('usage: cmdmark attach <run_id>');
	if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
		throw new Error('cmdmark attach requires an interactive local terminal');
	}
	const { settings } = await client.request('settings.get', {});
	const detachSequence = parseDetachSequence(settings.attachDetachKey || DETACH_KEY);
	const cols = process.stdout.columns || 80;
	const rows = process.stdout.rows || 24;
	const outputQueue: RpcNotification[] = [];
	let ready = false;
	let cursor = 0;
	let writeChain = Promise.resolve();
	let finish!: () => void;
	const done = new Promise<void>((resolve) => (finish = resolve));
	let detachRequested = false;
	let exitError: Error | null = null;
	let pendingInput = Buffer.alloc(0);
	const previousRawMode = process.stdin.isRaw;

	const onNotification = client.onNotification((notification) => {
		if (notification.method === 'run.output' && notification.params.runId === runId) {
			if (!ready) outputQueue.push(notification);
			else cursor = writeOutputChunk(notification, cursor);
		}
		if (notification.method === 'run.state' && notification.params.run.runId === runId && notification.params.run.endedAt !== null) {
			finish();
		}
	});

	const queueInput = (data: Buffer) => {
		if (data.length === 0) return;
		writeChain = writeChain.then(() => client.request('runs.write', { runId, dataBase64: data.toString('base64') })).then(() => undefined);
		writeChain.catch((error: Error) => {
			exitError = error;
			finish();
		});
	};

	const onInput = (chunk: Buffer | string) => {
		if (detachRequested) return;
		const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
		pendingInput = Buffer.concat([pendingInput, bytes]);
		const index = pendingInput.indexOf(detachSequence);
		if (index !== -1) {
			queueInput(pendingInput.subarray(0, index));
			detachRequested = true;
			finish();
			return;
		}
		const safeLength = Math.max(0, pendingInput.length - detachSequence.length + 1);
		if (safeLength > 0) {
			queueInput(pendingInput.subarray(0, safeLength));
			pendingInput = pendingInput.subarray(safeLength);
		}
	};

	const onResize = () => {
		void client.request('runs.resize', { runId, cols: process.stdout.columns || 80, rows: process.stdout.rows || 24 }).catch((error: Error) => {
			exitError = error;
			finish();
		});
	};
	const onInterrupt = () => finish();

	try {
		const attached = await client.request('runs.attach', { runId, cols, rows });
		const initial = decodeOutput(attached.initialOutputBase64);
		process.stdout.write(initial);
		cursor = attached.offset + initial.length;
		ready = true;
		outputQueue.sort((left, right) => outputOffset(left) - outputOffset(right));
		for (const notification of outputQueue) cursor = writeOutputChunk(notification, cursor);
		outputQueue.length = 0;

		process.stdin.setRawMode(true);
		process.stdin.resume();
		process.stdin.on('data', onInput);
		process.stdout.on('resize', onResize);
		process.on('SIGWINCH', onResize);
		process.on('SIGINT', onInterrupt);
		await done;
	} finally {
		process.stdin.off('data', onInput);
		process.stdout.off('resize', onResize);
		process.off('SIGWINCH', onResize);
		process.off('SIGINT', onInterrupt);
		process.stdin.pause();
		if (process.stdin.isTTY) process.stdin.setRawMode(previousRawMode);
		onNotification();
		if (detachRequested) await writeChain.catch((error: Error) => { exitError ??= error; });
		await client.request('runs.detach', { runId }).catch(() => {});
		if (exitError) throw exitError;
	}
}

function parseParameterOptions(args: string[]): Record<string, string> {
	const values: Record<string, string> = {};
	for (let index = 0; index < args.length; index++) {
		if (args[index] !== '--param' && args[index] !== '-p') throw new Error(`unknown run option: ${args[index]}`);
		const assignment = args[++index];
		const splitAt = assignment?.indexOf('=') ?? -1;
		if (splitAt < 1) throw new Error('parameter values use --param name=value');
		values[assignment!.slice(0, splitAt)] = assignment!.slice(splitAt + 1);
	}
	return values;
}

async function collectTemplateValues(
	template: string,
	parameters: Array<{ name: string; default?: string; promptLabel?: string }>,
	provided: Record<string, string>
): Promise<Record<string, string>> {
	const values = { ...provided };
	const missing = templateVariables(template, parameters).filter((variable) => {
		if (values[variable.name] !== undefined) return false;
		if (variable.defaultValue !== undefined) {
			values[variable.name] = variable.defaultValue;
			return false;
		}
		return true;
	});
	if (missing.length === 0) return values;
	if (!process.stdin.isTTY) throw new Error(`missing template values: ${missing.map(({ name }) => name).join(', ')}; pass --param name=value`);
	const prompt = createInterface({ input: process.stdin, output: process.stderr });
	try {
		for (const variable of missing) values[variable.name] = await prompt.question(`${variable.label}: `);
	} finally {
		prompt.close();
	}
	return values;
}

function writeOutputChunk(notification: Extract<RpcNotification, { method: 'run.output' }>, cursor: number): number;
function writeOutputChunk(notification: RpcNotification, cursor: number): number;
function writeOutputChunk(notification: RpcNotification, cursor: number): number {
	if (notification.method !== 'run.output') return cursor;
	const data = decodeOutput(notification.params.dataBase64);
	const end = notification.params.offset + data.length;
	if (end <= cursor) return cursor;
	const skip = Math.max(0, cursor - notification.params.offset);
	process.stdout.write(data.subarray(skip));
	return end;
}

function outputOffset(notification: RpcNotification): number {
	return notification.method === 'run.output' ? notification.params.offset : 0;
}

function parseDetachSequence(value: string): Buffer {
	const normalized = value.trim().toLocaleLowerCase();
	if (/^ctrl-[a-z]$/.test(normalized)) return Buffer.from([normalized.charCodeAt(5) - 96]);
	if (normalized === 'ctrl-]') return Buffer.from([0x1d]);
	if (/^\\x[0-9a-f]{2}$/i.test(value)) return Buffer.from([Number.parseInt(value.slice(2), 16)]);
	return Buffer.from(value);
}

function commandLineArguments(): string[] {
	const entry = process.argv[1] ?? '';
	return /\.(?:ts|[cm]?js)$/.test(entry) || entry.startsWith('/$bunfs/')
		? process.argv.slice(2)
		: process.argv.slice(1);
}

function printRun(run: RunRecord): void {
	const exit = run.exitCode === null ? '' : ` exit=${run.exitCode}`;
	process.stdout.write(`${run.runId}\t${run.state}\tpid=${run.pid ?? '-'}\t${run.resolvedCommand}${exit}\n`);
}

function printUsage(): void {
	process.stdout.write(`cmdmark — Linux command bookmarks and process manager

Usage:
  cmdmark add <name> -- <shell command>
  cmdmark list
  cmdmark search <query>
  cmdmark run <command_id> [--param name=value] | cmdmark run -- <shell command>
  cmdmark ps
  cmdmark stop <run_id>
  cmdmark kill <run_id>
  cmdmark logs <run_id> [--follow]
  cmdmark attach <run_id>
`);
}

main().catch((error: unknown) => {
	process.stderr.write(`cmdmark: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});
