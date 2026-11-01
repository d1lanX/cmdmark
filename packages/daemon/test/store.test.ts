import { afterEach, describe, expect, test } from 'bun:test';
import { CommandStore } from '../src/store.ts';

describe('CommandStore', () => {
	let store: CommandStore | undefined;

	afterEach(() => {
		store?.close();
		store = undefined;
	});

	test('migrates an in-memory database and creates normalized commands', () => {
		store = new CommandStore();
		const version = store.db.query<{ user_version: number }, []>('PRAGMA user_version').get()?.user_version;
		const command = store.createCommand({
			name: '  Build app  ',
			command: 'bun run build',
			tags: [' Dev ', 'dev', 'Build'],
			env: { CI: '1' },
			params: [{ name: 'target', default: 'linux', promptLabel: 'Target platform' }]
		}, 100);

		expect(version).toBe(1);
		expect(command.name).toBe('Build app');
		expect(command.tags).toEqual(['dev', 'build']);
		expect(command.env).toEqual({ CI: '1' });
		expect(command.shell).toBe(process.env.SHELL || '/bin/sh');
		expect(command.createdAt).toBe(100);
		expect(command.lastUsedAt).toBeNull();
		expect(command.params[0]).toEqual({ name: 'target', default: 'linux', promptLabel: 'Target platform' });
	});

	test('updates, favorites, duplicates, and deletes bookmarks without deleting run history', () => {
		store = new CommandStore();
		const original = store.createCommand({ name: 'Server', command: 'bun run dev', tags: ['web'] }, 100);
		const run = store.createRun({ commandId: original.id, resolvedCommand: 'bun run dev', logPath: '/logs/run.log' });

		const updated = store.updateCommand(original.id, { description: 'local server', cwd: '/workspace' }, 200);
		const favorite = store.setFavorite(updated.id, true, 300);
		const duplicate = store.duplicateCommand(favorite.id, 400);
		const listed = store.listCommands({ tag: 'WEB' });
		expect(favorite.favorite).toBe(true);
		expect(duplicate.name).toBe('Server copy');
		expect(duplicate.favorite).toBe(false);
		expect(listed.map(({ id }) => id)).toContain(original.id);

		expect(store.deleteCommand(original.id)).toBe(true);
		expect(store.getCommand(original.id)).toBeNull();
		expect(store.getRun(run.runId)?.commandId).toBeNull();
	});

	test('tracks use counts and persists run state and process metadata', () => {
		store = new CommandStore();
		const command = store.createCommand({ name: 'Long job', command: 'sleep 20' }, 100);
		store.markCommandUsed(command.id, 200);
		const run = store.createRun({ commandId: command.id, resolvedCommand: 'sleep 20', logPath: '/logs/a.log', startedAt: 210 });
		store.updateRun(run.runId, { state: 'running', pid: 123, pgid: 123, procStartTime: '876543' });

		expect(store.getCommand(command.id)?.useCount).toBe(1);
		expect(store.getCommand(command.id)?.lastUsedAt).toBe(200);
		expect(store.getRun(run.runId)).toMatchObject({ state: 'running', pid: 123, pgid: 123, procStartTime: '876543' });
		expect(store.markRunningRunsLost(500)).toBe(1);
		expect(store.getRun(run.runId)).toMatchObject({ state: 'lost', endedAt: 500 });
	});

	test('validates required fields, environment names, and unique parameter names', () => {
		store = new CommandStore();
		expect(() => store!.createCommand({ name: '', command: 'echo ok' })).toThrow('name is required');
		expect(() => store!.createCommand({ name: 'Bad env', command: 'echo ok', env: { 'BAD-NAME': 'x' } })).toThrow('invalid environment variable name');
		expect(() => store!.createCommand({
			name: 'Bad params',
			command: 'echo ok',
			params: [{ name: 'x' }, { name: 'x' }]
		})).toThrow('duplicate parameter name');
	});
});

describe('command search', () => {
	let store: CommandStore | undefined;

	afterEach(() => {
		store?.close();
		store = undefined;
	});

	test('uses FTS5 when available and matches command metadata and tags', () => {
		store = new CommandStore();
		const tagged = store.createCommand({ name: 'Compile', command: 'bun build', tags: ['tooling'] });
		const other = store.createCommand({ name: 'Serve', command: 'bun run dev' });
		const hits = store.searchCommands('tooling');

		expect(typeof store.fts5Enabled).toBe('boolean');
		expect(hits.map(({ command }) => command.id)).toContain(tagged.id);
		expect(hits.map(({ command }) => command.id)).not.toContain(other.id);
	});

	test('boosts favorites and recent usage for matching bookmarks', () => {
		store = new CommandStore();
		const older = store.createCommand({ name: 'Bun tasks', command: 'bun run test' }, 10);
		const favorite = store.createCommand({ name: 'Bun builds', command: 'bun run build', favorite: true }, 20);
		store.markCommandUsed(favorite.id, 1000);

		const hits = store.searchCommands('bun', {}, 1000);
		expect(hits[0]?.command.id).toBe(favorite.id);
		expect(hits.some(({ command }) => command.id === older.id)).toBe(true);
	});

	test('falls back to fuzzy scoring when FTS5 is disabled', () => {
		store = new CommandStore(':memory:', { fts5: false });
		const command = store.createCommand({ name: 'Build', command: 'bun run build' });
		const hits = store.searchCommands('buid');

		expect(store.fts5Enabled).toBe(false);
		expect(hits[0]?.command.id).toBe(command.id);
	});
});
