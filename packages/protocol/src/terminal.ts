import { accessSync, constants } from 'node:fs';
import { basename, isAbsolute, join, resolve } from 'node:path';

/** `-e` takes the command as one string for most emulators; `-x` takes argv words for terminator. */
export interface TerminalCommand {
	executable: string;
	args: string[];
	kind: 'xdg' | 'dash-e' | 'double-dash' | 'dash-x';
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

	for (const name of ['kitty', 'alacritty', 'terminator', 'gnome-terminal', 'konsole', 'xterm']) {
		const executable = lookup(name);
		if (executable) return { executable, args: [], kind: terminalKind(name) };
	}
	return null;
}

export function terminalArguments(terminal: TerminalCommand, command: string, args: string[]): string[] {
	if (terminal.kind === 'xdg') return [...terminal.args, command, ...args];
	if (terminal.kind === 'double-dash') return [...terminal.args, '--', command, ...args];
	if (terminal.kind === 'dash-x') return [...terminal.args, '-x', command, ...args];
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

function terminalKind(name: string): TerminalCommand['kind'] {
	const command = basename(name).toLocaleLowerCase();
	if (command === 'xdg-terminal-exec') return 'xdg';
	if (command === 'gnome-terminal') return 'double-dash';
	if (command === 'terminator') return 'dash-x';
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
