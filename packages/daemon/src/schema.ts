import type { Database } from 'bun:sqlite';

interface Migration {
	version: number;
	sql: string;
}

const MIGRATIONS: Migration[] = [
	{
		version: 1,
		sql: `
CREATE TABLE commands (
	id TEXT PRIMARY KEY NOT NULL,
	name TEXT NOT NULL,
	command TEXT NOT NULL,
	description TEXT NOT NULL DEFAULT '',
	cwd TEXT,
	env_json TEXT NOT NULL DEFAULT '{}',
	shell TEXT NOT NULL,
	tags_json TEXT NOT NULL DEFAULT '[]',
	favorite INTEGER NOT NULL DEFAULT 0 CHECK (favorite IN (0, 1)),
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	last_used_at INTEGER,
	use_count INTEGER NOT NULL DEFAULT 0 CHECK (use_count >= 0),
	params_json TEXT NOT NULL DEFAULT '[]'
) STRICT;

CREATE INDEX commands_favorite_recent ON commands(favorite DESC, last_used_at DESC, created_at DESC);
CREATE INDEX commands_updated ON commands(updated_at DESC);

CREATE TABLE runs (
	run_id TEXT PRIMARY KEY NOT NULL,
	command_id TEXT REFERENCES commands(id) ON DELETE SET NULL,
	resolved_command TEXT NOT NULL,
	cwd TEXT,
	pid INTEGER,
	pgid INTEGER,
	proc_start_time TEXT,
	state TEXT NOT NULL CHECK (state IN ('starting', 'running', 'stopped', 'exited', 'killed', 'failed', 'lost')),
	started_at INTEGER NOT NULL,
	ended_at INTEGER,
	exit_code INTEGER,
	signal TEXT,
	log_path TEXT NOT NULL
) STRICT;

CREATE INDEX runs_started ON runs(started_at DESC);
CREATE INDEX runs_state_started ON runs(state, started_at DESC);
CREATE INDEX runs_command_started ON runs(command_id, started_at DESC);

CREATE TABLE settings (
	key TEXT PRIMARY KEY NOT NULL,
	value TEXT NOT NULL
) STRICT;
`
	}
];

export const SCHEMA_VERSION = MIGRATIONS.at(-1)?.version ?? 0;

export function configureDatabase(db: Database): void {
	db.exec('PRAGMA foreign_keys = ON');
	db.exec('PRAGMA journal_mode = WAL');
	db.exec('PRAGMA synchronous = NORMAL');
	db.exec('PRAGMA busy_timeout = 5000');
	db.exec('PRAGMA temp_store = MEMORY');
}

export function migrateDatabase(db: Database): number {
	const row = db.query<{ user_version: number }, []>('PRAGMA user_version').get();
	let version = row?.user_version ?? 0;
	if (version > SCHEMA_VERSION) {
		throw new Error(`database schema ${version} is newer than this cmdmark version (${SCHEMA_VERSION})`);
	}

	for (const migration of MIGRATIONS) {
		if (version >= migration.version) continue;
		const nextVersion = migration.version;
		db.transaction(() => {
			db.exec(migration.sql);
			db.exec(`PRAGMA user_version = ${nextVersion}`);
		})();
		version = nextVersion;
	}
	return version;
}

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS commands_fts USING fts5(
	name, command, description, tags_json,
	content='commands', content_rowid='rowid',
	tokenize='unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS commands_fts_ai AFTER INSERT ON commands BEGIN
	INSERT INTO commands_fts(rowid, name, command, description, tags_json)
	VALUES (new.rowid, new.name, new.command, new.description, new.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS commands_fts_ad AFTER DELETE ON commands BEGIN
	INSERT INTO commands_fts(commands_fts, rowid, name, command, description, tags_json)
	VALUES ('delete', old.rowid, old.name, old.command, old.description, old.tags_json);
END;

CREATE TRIGGER IF NOT EXISTS commands_fts_au AFTER UPDATE OF name, command, description, tags_json ON commands BEGIN
	INSERT INTO commands_fts(commands_fts, rowid, name, command, description, tags_json)
	VALUES ('delete', old.rowid, old.name, old.command, old.description, old.tags_json);
	INSERT INTO commands_fts(rowid, name, command, description, tags_json)
	VALUES (new.rowid, new.name, new.command, new.description, new.tags_json);
END;
`;

export function enableFts5(db: Database): boolean {
	try {
		db.transaction(() => {
			db.exec(FTS_SCHEMA);
			db.exec("INSERT INTO commands_fts(commands_fts) VALUES ('rebuild')");
		})();
		return true;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/no such module:\s*fts5|fts5.*not available/i.test(message)) return false;
		throw error;
	}
}
