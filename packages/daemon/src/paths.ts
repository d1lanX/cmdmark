import { homedir } from 'node:os';
import { join } from 'node:path';

export interface DaemonPaths {
	stateDirectory: string;
	databasePath: string;
	logDirectory: string;
	socketPath: string;
}

export function resolveDaemonPaths(env: NodeJS.ProcessEnv = process.env): DaemonPaths {
	const stateHome = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
	const stateDirectory = join(stateHome, 'cmdmark');
	return {
		stateDirectory,
		databasePath: join(stateDirectory, 'cmdmark.sqlite'),
		logDirectory: join(stateDirectory, 'logs'),
		socketPath: defaultSocketPathFromEnv(env)
	};
}

function defaultSocketPathFromEnv(env: NodeJS.ProcessEnv): string {
	const runtimeDirectory = env.XDG_RUNTIME_DIR;
	if (!runtimeDirectory) throw new Error('XDG_RUNTIME_DIR is not set; cmdmark requires a user runtime directory');
	return `${runtimeDirectory.replace(/\/$/, '')}/cmdmark.sock`;
}
