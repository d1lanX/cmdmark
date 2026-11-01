import { constants } from 'node:fs';
import { accessSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DaemonLaunchSpec } from '@cmdmark/protocol/autostart';

export interface TerminalCommand {
	executable: string;
	args: string[];
	kind: 'xdg' | 'dash-e' | 'double-dash';
}

export type ExecutableLookup = (name: string, pathValue?: string) => string | null;

export function resolveTerminalCommand(
	setting: string | null | undefined,
	environmentTerminal: string | undefined,
	lookup: ExecutableLookup = findExecutable
): TerminalCommand | null {
	for (const commandText of [setting, environmentTerminal]) {
		if (!commandText?.trim()) continue;
		const [name, ...args] = splitCommand(commandText);
		if (!name) continue;
		const executable = lookup(name);
		if (executable) return { executable, args, kind: terminalKind(name) };
	}

	const xdg = lookup('xdg-terminal-exec');
	if (xdg) return { executable: xdg, args: [], kind: 'xdg' };

	for (const name of ['kitty', 'alacritty', 'gnome-terminal', 'konsole', 'xterm']) {
		const executable = lookup(name);
		if (executable) return { executable, args: [], kind: terminalKind(name) };
	}
	return null;
}

export function terminalArguments(terminal: TerminalCommand, command: string, args: string[]): string[] {
	if (terminal.kind === 'xdg') return [...terminal.args, command, ...args];
	if (terminal.kind === 'double-dash') return [...terminal.args, '--', command, ...args];
	return [...terminal.args, '-e', command, ...args];
}

export function splitCommand(command: string): string[] {
	const words: string[] = [];
	let word = '';
	let quote: 'single' | 'double' | null = null;
	let escaped = false;
	let started = false;
	for (const character of command.trim()) {
		if (escaped) {
			word += character;
			escaped = false;
			started = true;
			continue;
		}
		if (character === '\\' && quote !== 'single') {
			escaped = true;
			started = true;
			continue;
		}
		if (quote === 'single') {
			if (character === "'") quote = null;
			else word += character;
			started = true;
			continue;
		}
		if (quote === 'double') {
			if (character === '"') quote = null;
			else word += character;
			started = true;
			continue;
		}
		if (character === "'") {
			quote = 'single';
			started = true;
		} else if (character === '"') {
			quote = 'double';
			started = true;
		} else if (/\s/.test(character)) {
			if (started) words.push(word);
			word = '';
			started = false;
		} else {
			word += character;
			started = true;
		}
	}
	if (escaped) word += '\\';
	if (started) words.push(word);
	return words;
}

export function findExecutable(name: string, pathValue = process.env.PATH ?? ''): string | null {
	if (name.includes('/')) {
		const candidate = isAbsolute(name) ? name : resolve(name);
		return isExecutable(candidate) ? candidate : null;
	}
	for (const directory of pathValue.split(':').filter(Boolean)) {
		const candidate = join(directory, name);
		if (isExecutable(candidate)) return candidate;
	}
	return null;
}

export async function launchTerminal(runId: string, setting: string | null): Promise<void> {
	const terminal = resolveTerminalCommand(setting, process.env.TERMINAL);
	if (!terminal) throw new Error('No terminal emulator found. Set a terminal in Settings or install xdg-terminal-exec, kitty, alacritty, gnome-terminal, konsole, or xterm.');
	const cli = defaultCliInvocation();
	const args = terminalArguments(terminal, cli.command, [...cli.args, 'attach', runId]);
	await new Promise<void>((resolvePromise, reject) => {
		const child = spawn(terminal.executable, args, { detached: true, stdio: 'ignore', env: process.env });
		child.once('spawn', () => {
			child.unref();
			resolvePromise();
		});
		child.once('error', reject);
	});
}

function terminalKind(name: string): TerminalCommand['kind'] {
	const command = basename(name).toLocaleLowerCase();
	if (command === 'xdg-terminal-exec') return 'xdg';
	if (command === 'gnome-terminal') return 'double-dash';
	return 'dash-e';
}

function isExecutable(path: string): boolean {
	try {
		accessSync(path, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

function defaultCliInvocation(): DaemonLaunchSpec {
	const source = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url));
	if (process.env.CMDMARK_BIN) {
		const configured = findExecutable(process.env.CMDMARK_BIN);
		if (configured) return { command: configured, args: [] };
	}
	const runtimeName = basename(process.execPath).toLocaleLowerCase();
	const runningOnBunRuntime = runtimeName === 'bun' || runtimeName === 'bun.exe';
	if (runningOnBunRuntime) {
		try {
			accessSync(source, constants.R_OK);
			return { command: process.execPath, args: [source] };
		} catch {}
	}
	const sibling = join(dirname(process.execPath), 'cmdmark');
	if (isExecutable(sibling)) return { command: sibling, args: [] };
	const onPath = findExecutable('cmdmark');
	if (onPath) return { command: onPath, args: [] };
	throw new Error('cmdmark CLI executable was not found; set CMDMARK_BIN or install cmdmark');
}
