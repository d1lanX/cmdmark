import { describe, expect, test } from 'bun:test';
import { resolveTerminalCommand, splitCommand, terminalArguments } from '../src/terminal.ts';

describe('terminal emulator selection', () => {
	test('prefers the user setting, then $TERMINAL, then xdg-terminal-exec and fallbacks', () => {
		const lookup = (name: string) => ({
			kitty: '/usr/bin/kitty',
			alacritty: '/usr/bin/alacritty',
			'xdg-terminal-exec': '/usr/bin/xdg-terminal-exec',
			foot: '/usr/bin/foot'
		}[name] ?? null);
		expect(resolveTerminalCommand('foot --app-id cmdmark', 'kitty', lookup)).toEqual({ executable: '/usr/bin/foot', args: ['--app-id', 'cmdmark'], kind: 'dash-e' });
		expect(resolveTerminalCommand(null, 'kitty', lookup)?.executable).toBe('/usr/bin/kitty');
		expect(resolveTerminalCommand(null, undefined, lookup)?.executable).toBe('/usr/bin/xdg-terminal-exec');
	});

	test('uses the correct execution separator for supported terminal emulators', () => {
		expect(terminalArguments({ executable: 'gnome-terminal', args: [], kind: 'double-dash' }, 'cmdmark', ['attach', 'r1']))
			.toEqual(['--', 'cmdmark', 'attach', 'r1']);
		expect(terminalArguments({ executable: 'kitty', args: [], kind: 'dash-e' }, 'cmdmark', ['attach', 'r1']))
			.toEqual(['-e', 'cmdmark', 'attach', 'r1']);
		expect(terminalArguments({ executable: 'xdg-terminal-exec', args: [], kind: 'xdg' }, 'cmdmark', ['attach', 'r1']))
			.toEqual(['cmdmark', 'attach', 'r1']);
		expect(terminalArguments({ executable: 'terminator', args: [], kind: 'dash-x' }, 'cmdmark', ['attach', 'r1']))
			.toEqual(['-x', 'cmdmark', 'attach', 'r1']);
	});

	test('resolves terminator to its argv-rest form', () => {
		expect(resolveTerminalCommand('terminator', undefined, (name: string) => (name === 'terminator' ? '/usr/bin/terminator' : null)))
			.toEqual({ executable: '/usr/bin/terminator', args: [], kind: 'dash-x' });
	});

	test('parses a configured terminal command without invoking a shell', () => {
		expect(splitCommand('foot --title "cmdmark session"')).toEqual(['foot', '--title', 'cmdmark session']);
	});
});
