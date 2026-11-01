import { Database } from 'bun:sqlite';
import { randomUUID } from 'node:crypto';
import type {
	CommandDraft,
	CommandParameter,
	CommandPatch,
	CommandRecord,
	RunRecord,
	RunState,
	SearchHit,
	SettingsRecord
} from '@cmdmark/protocol';
import { rankFtsResults, rankFuzzyResults, toFtsQuery } from './search.ts';
import { configureDatabase, enableFts5, migrateDatabase } from './schema.ts';

interface CommandRow {
	id: string;
	name: string;
	command: string;
	description: string;
	cwd: string | null;
	env_json: string;
	shell: string;
	tags_json: string;
	favorite: number;
	created_at: number;
	updated_at: number;
	last_used_at: number | null;
	use_count: number;
	params_json: string;
}

interface RunRow {
	run_id: string;
	command_id: string | null;
	resolved_command: string;
	cwd: string | null;
	pid: number | null;
	pgid: number | null;
	proc_start_time: string | null;
	state: RunState;
	started_at: number;
	ended_at: number | null;
	exit_code: number | null;
	signal: string | null;
	log_path: string;
}

interface SettingsRow {
	value: string;
}

export interface CommandListOptions {
	tag?: string;
	favorite?: boolean;
}

export interface CommandSearchOptions {
	tag?: string;
}

export interface NewRun {
	runId?: string;
	commandId?: string | null;
	resolvedCommand: string;
	cwd?: string | null;
	state?: RunState;
	startedAt?: number;
	logPath: string;
}

export type RunPatch = Partial<Omit<RunRecord, 'runId'>>;

export interface StoreOptions {
	/** Disable FTS5 to exercise the fuzzy fallback, or on SQLite builds without the extension. */
	fts5?: boolean;
	defaultShell?: string;
}

const SETTINGS_KEY = 'preferences';
const DEFAULT_GRACE_PERIOD_MS = 5000;
const DEFAULT_BUFFER_SIZE_BYTES = 256 * 1024;
const MAX_BUFFER_SIZE_BYTES = 64 * 1024 * 1024;

export class CommandStore {
	readonly db: Database;
	readonly fts5Enabled: boolean;
	readonly defaultShell: string;

	constructor(path = ':memory:', options: StoreOptions = {}) {
		this.db = new Database(path, { create: true, strict: true });
		this.defaultShell = options.defaultShell?.trim() || process.env.SHELL || '/bin/sh';
		configureDatabase(this.db);
		migrateDatabase(this.db);
		this.fts5Enabled = options.fts5 === false ? false : enableFts5(this.db);
	}

	close(): void {
		this.db.close();
	}

	createCommand(draft: CommandDraft, now = Date.now()): CommandRecord {
		const normalized = normalizeCommand(draft, this.defaultShell);
		const id = randomUUID();
		this.db.query(`
			INSERT INTO commands (
				id, name, command, description, cwd, env_json, shell, tags_json,
				favorite, created_at, updated_at, last_used_at, use_count, params_json
			) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?)
		`).run(
			id,
			normalized.name,
			normalized.command,
			normalized.description,
			normalized.cwd,
			JSON.stringify(normalized.env),
			normalized.shell,
			JSON.stringify(normalized.tags),
			normalized.favorite ? 1 : 0,
			now,
			now,
			JSON.stringify(normalized.params)
		);
		return this.getCommand(id)!;
	}

	getCommand(id: string): CommandRecord | null {
		const row = this.db.query<CommandRow, [string]>('SELECT * FROM commands WHERE id = ?').get(id);
		return row ? commandFromRow(row) : null;
	}

	listCommands(options: CommandListOptions = {}): CommandRecord[] {
		const rows = this.db.query<CommandRow, []>(`
			SELECT * FROM commands
			ORDER BY favorite DESC, last_used_at DESC, updated_at DESC, name COLLATE NOCASE ASC
		`).all();
		const tag = options.tag?.trim().toLocaleLowerCase();
		return rows
			.map(commandFromRow)
			.filter((command) => options.favorite === undefined || command.favorite === options.favorite)
			.filter((command) => !tag || command.tags.includes(tag));
	}

	updateCommand(id: string, patch: CommandPatch, now = Date.now()): CommandRecord {
		const current = this.getCommand(id);
		if (!current) throw new Error(`command not found: ${id}`);
		const merged: CommandDraft = {
			name: patch.name ?? current.name,
			command: patch.command ?? current.command,
			description: patch.description ?? current.description,
			cwd: patch.cwd === undefined ? current.cwd : patch.cwd,
			env: patch.env ?? current.env,
			shell: patch.shell ?? current.shell,
			tags: patch.tags ?? current.tags,
			favorite: patch.favorite ?? current.favorite,
			params: patch.params ?? current.params
		};
		const normalized = normalizeCommand(merged, this.defaultShell);
		this.db.query(`
			UPDATE commands
			SET name = ?, command = ?, description = ?, cwd = ?, env_json = ?, shell = ?,
				tags_json = ?, favorite = ?, updated_at = ?, params_json = ?
			WHERE id = ?
		`).run(
			normalized.name,
			normalized.command,
			normalized.description,
			normalized.cwd,
			JSON.stringify(normalized.env),
			normalized.shell,
			JSON.stringify(normalized.tags),
			normalized.favorite ? 1 : 0,
			now,
			JSON.stringify(normalized.params),
			id
		);
		return this.getCommand(id)!;
	}

	deleteCommand(id: string): boolean {
		return this.db.query('DELETE FROM commands WHERE id = ?').run(id).changes > 0;
	}

	duplicateCommand(id: string, now = Date.now()): CommandRecord {
		const command = this.getCommand(id);
		if (!command) throw new Error(`command not found: ${id}`);
		return this.createCommand(
			{
				name: `${command.name} copy`,
				command: command.command,
				description: command.description,
				cwd: command.cwd,
				env: command.env,
				shell: command.shell,
				tags: command.tags,
				favorite: false,
				params: command.params
			},
			now
		);
	}

	setFavorite(id: string, favorite: boolean, now = Date.now()): CommandRecord {
		return this.updateCommand(id, { favorite }, now);
	}

	markCommandUsed(id: string, now = Date.now()): void {
		const result = this.db.query(`
			UPDATE commands SET last_used_at = ?, use_count = use_count + 1, updated_at = ? WHERE id = ?
		`).run(now, now, id);
		if (result.changes === 0) throw new Error(`command not found: ${id}`);
	}

	searchCommands(query: string, options: CommandSearchOptions = {}, now = Date.now()): SearchHit[] {
		const normalizedQuery = query.trim();
		const commands = this.listCommands({ tag: options.tag });
		if (!normalizedQuery) {
			return commands
				.map((command) => ({ command, score: (command.favorite ? 0.15 : 0) + recentBoost(command.lastUsedAt, now) }))
				.sort((a, b) => b.score - a.score || b.command.updatedAt - a.command.updatedAt);
		}

		if (this.fts5Enabled) {
			const match = toFtsQuery(normalizedQuery);
			if (!match) return [];
			const rows = this.db.query<{ id: string; rank: number }, [string]>(`
				SELECT commands.id AS id, bm25(commands_fts, 5.0, 3.0, 2.0, 1.0) AS rank
				FROM commands_fts
				JOIN commands ON commands.rowid = commands_fts.rowid
				WHERE commands_fts MATCH ?
				ORDER BY rank ASC
			`).all(match);
			const byId = new Map(commands.map((command) => [command.id, command]));
			const ranked = rows.flatMap((row) => {
				const command = byId.get(row.id);
				return command ? [{ command, ftsRank: row.rank }] : [];
			});
			return rankFtsResults(ranked, now);
		}

		return rankFuzzyResults(commands, normalizedQuery, now);
	}

	createRun(input: NewRun): RunRecord {
		const runId = input.runId ?? randomUUID();
		const state = input.state ?? 'starting';
		assertRunState(state);
		if (input.commandId && !this.getCommand(input.commandId)) throw new Error(`command not found: ${input.commandId}`);
		this.db.query(`
			INSERT INTO runs (
				run_id, command_id, resolved_command, cwd, pid, pgid, proc_start_time,
				state, started_at, ended_at, exit_code, signal, log_path
			) VALUES (?, ?, ?, ?, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL, ?)
		`).run(
			runId,
			input.commandId ?? null,
			input.resolvedCommand,
			input.cwd ?? null,
			state,
			input.startedAt ?? Date.now(),
			input.logPath
		);
		return this.getRun(runId)!;
	}

	getRun(runId: string): RunRecord | null {
		const row = this.db.query<RunRow, [string]>('SELECT * FROM runs WHERE run_id = ?').get(runId);
		return row ? runFromRow(row) : null;
	}

	listRuns(state?: RunState): RunRecord[] {
		if (state) {
			assertRunState(state);
			return this.db.query<RunRow, [RunState]>(
				'SELECT * FROM runs WHERE state = ? ORDER BY started_at DESC'
			).all(state).map(runFromRow);
		}
		return this.db.query<RunRow, []>('SELECT * FROM runs ORDER BY started_at DESC').all().map(runFromRow);
	}

	updateRun(runId: string, patch: RunPatch): RunRecord {
		const current = this.getRun(runId);
		if (!current) throw new Error(`run not found: ${runId}`);
		const next = { ...current, ...patch };
		assertRunState(next.state);
		this.db.query(`
			UPDATE runs SET command_id = ?, resolved_command = ?, cwd = ?, pid = ?, pgid = ?,
				proc_start_time = ?, state = ?, started_at = ?, ended_at = ?, exit_code = ?, signal = ?, log_path = ?
			WHERE run_id = ?
		`).run(
			next.commandId,
			next.resolvedCommand,
			next.cwd,
			next.pid,
			next.pgid,
			next.procStartTime,
			next.state,
			next.startedAt,
			next.endedAt,
			next.exitCode,
			next.signal,
			next.logPath,
			runId
		);
		return this.getRun(runId)!;
	}

	markRunningRunsLost(now = Date.now()): number {
		return this.db.query(`
			UPDATE runs SET state = 'lost', ended_at = ?
			WHERE state = 'running'
		`).run(now).changes;
	}

	getSettings(): SettingsRecord {
		const row = this.db.query<SettingsRow, [string]>('SELECT value FROM settings WHERE key = ?').get(SETTINGS_KEY);
		const stored = row ? parseJson<Partial<SettingsRecord>>(row.value, 'settings') : {};
		return normalizeSettings(stored, this.defaultShell);
	}

	updateSettings(patch: Partial<SettingsRecord>): SettingsRecord {
		const next = normalizeSettings({ ...this.getSettings(), ...patch }, this.defaultShell);
		this.db.query(`
			INSERT INTO settings(key, value) VALUES (?, ?)
			ON CONFLICT(key) DO UPDATE SET value = excluded.value
		`).run(SETTINGS_KEY, JSON.stringify(next));
		return next;
	}
}

function normalizeCommand(input: CommandDraft, defaultShell: string): Omit<CommandRecord, 'id' | 'createdAt' | 'updatedAt' | 'lastUsedAt' | 'useCount'> {
	const name = requireText(input.name, 'name');
	const command = requireText(input.command, 'command');
	const description = typeof input.description === 'string' ? input.description.trim() : '';
	const cwd = input.cwd == null || input.cwd.trim() === '' ? null : input.cwd.trim();
	const shell = typeof input.shell === 'string' && input.shell.trim() ? input.shell.trim() : defaultShell;
	const env = normalizeEnv(input.env ?? {});
	const tags = normalizeTags(input.tags ?? []);
	const params = normalizeParams(input.params ?? []);
	return { name, command, description, cwd, env, shell, tags, favorite: input.favorite ?? false, params };
}

function normalizeEnv(value: Record<string, string>): Record<string, string> {
	if (!isPlainRecord(value)) throw new TypeError('env must be an object of string values');
	const entries = Object.entries(value);
	for (const [key, item] of entries) {
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new TypeError(`invalid environment variable name: ${key}`);
		if (typeof item !== 'string') throw new TypeError(`environment variable ${key} must be a string`);
	}
	return Object.fromEntries(entries);
}

function normalizeTags(value: string[]): string[] {
	if (!Array.isArray(value)) throw new TypeError('tags must be an array of strings');
	return [...new Set(value.map((tag) => {
		if (typeof tag !== 'string') throw new TypeError('tag values must be strings');
		return tag.trim().toLocaleLowerCase();
	}).filter(Boolean))];
}

function normalizeParams(value: CommandParameter[]): CommandParameter[] {
	if (!Array.isArray(value)) throw new TypeError('params must be an array');
	const seen = new Set<string>();
	return value.map((parameter) => {
		if (!isPlainRecord(parameter)) throw new TypeError('each command parameter must be an object');
		const name = requireText(parameter.name, 'parameter name');
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new TypeError(`invalid parameter name: ${name}`);
		if (seen.has(name)) throw new TypeError(`duplicate parameter name: ${name}`);
		seen.add(name);
		if (parameter.default !== undefined && typeof parameter.default !== 'string') {
			throw new TypeError(`default for parameter ${name} must be a string`);
		}
		if (parameter.promptLabel !== undefined && typeof parameter.promptLabel !== 'string') {
			throw new TypeError(`prompt label for parameter ${name} must be a string`);
		}
		return {
			name,
			...(parameter.default === undefined ? {} : { default: parameter.default }),
			...(parameter.promptLabel === undefined ? {} : { promptLabel: parameter.promptLabel.trim() })
		};
	});
}

function normalizeSettings(value: Partial<SettingsRecord>, defaultShell: string): SettingsRecord {
	const gracePeriodMs = value.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
	const bufferSizeBytes = value.bufferSizeBytes ?? DEFAULT_BUFFER_SIZE_BYTES;
	if (!Number.isInteger(gracePeriodMs) || gracePeriodMs < 0 || gracePeriodMs > 10 * 60 * 1000) {
		throw new RangeError('gracePeriodMs must be an integer between 0 and 600000');
	}
	if (!Number.isInteger(bufferSizeBytes) || bufferSizeBytes < 1024 || bufferSizeBytes > MAX_BUFFER_SIZE_BYTES) {
		throw new RangeError(`bufferSizeBytes must be between 1024 and ${MAX_BUFFER_SIZE_BYTES}`);
	}
	const terminal = value.terminal ?? null;
	if (terminal !== null && typeof terminal !== 'string') throw new TypeError('terminal must be a string or null');
	const shell = value.defaultShell?.trim() || defaultShell;
	const attachDetachKey = value.attachDetachKey?.trim() || 'ctrl-]';
	return { terminal, defaultShell: shell, gracePeriodMs, bufferSizeBytes, attachDetachKey };
}

function commandFromRow(row: CommandRow): CommandRecord {
	return {
		id: row.id,
		name: row.name,
		command: row.command,
		description: row.description,
		cwd: row.cwd,
		env: parseJson<Record<string, string>>(row.env_json, 'command env'),
		shell: row.shell,
		tags: parseJson<string[]>(row.tags_json, 'command tags'),
		favorite: row.favorite === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
		lastUsedAt: row.last_used_at,
		useCount: row.use_count,
		params: parseJson<CommandParameter[]>(row.params_json, 'command params')
	};
}

function runFromRow(row: RunRow): RunRecord {
	return {
		runId: row.run_id,
		commandId: row.command_id,
		resolvedCommand: row.resolved_command,
		cwd: row.cwd,
		pid: row.pid,
		pgid: row.pgid,
		procStartTime: row.proc_start_time,
		state: row.state,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		exitCode: row.exit_code,
		signal: row.signal,
		logPath: row.log_path
	};
}

function parseJson<T>(json: string, label: string): T {
	try {
		return JSON.parse(json) as T;
	} catch (error) {
		throw new Error(`stored ${label} is invalid JSON`, { cause: error });
	}
}

function requireText(value: unknown, label: string): string {
	if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} is required`);
	return value.trim();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertRunState(value: string): asserts value is RunState {
	if (!['starting', 'running', 'stopped', 'exited', 'killed', 'failed', 'lost'].includes(value)) {
		throw new TypeError(`invalid run state: ${value}`);
	}
}

function recentBoost(lastUsedAt: number | null, now: number): number {
	if (lastUsedAt === null) return 0;
	return 0.1 * Math.exp(-Math.max(0, (now - lastUsedAt) / 86_400_000) / 30);
}
