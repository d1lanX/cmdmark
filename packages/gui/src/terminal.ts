import { closeSync, openSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { defaultCliLaunchSpec } from '@cmdmark/protocol/autostart';
import { resolveTerminalCommand, terminalArguments } from '@cmdmark/protocol/terminal';

export async function launchTerminal(runId: string, setting: string | null): Promise<void> {
	const terminal = resolveTerminalCommand(setting, process.env.TERMINAL);
	if (!terminal) {
		throw new Error('No terminal emulator found. Set a terminal in Settings or install xdg-terminal-exec, kitty, alacritty, terminator, gnome-terminal, konsole, or xterm.');
	}
	const cliEntry = fileURLToPath(new URL('../../cli/src/main.ts', import.meta.url));
	const cli = defaultCliLaunchSpec(cliEntry);
	const args = terminalArguments(terminal, cli.command, [...cli.args, 'attach', runId]);
	await new Promise<void>((resolvePromise, reject) => {
		// Keep detached GUI applications' stdio connected to /dev/null rather than closed.
		const devnull = openSync('/dev/null', 'w');
		try {
			const child = spawn(terminal.executable, args, {
				detached: true,
				stdio: ['ignore', devnull, devnull],
				env: process.env
			});
			child.once('spawn', () => {
				child.unref();
				resolvePromise();
			});
			child.once('error', reject);
		} finally {
			closeSync(devnull);
		}
	});
}
