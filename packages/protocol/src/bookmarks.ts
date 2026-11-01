import type { CommandDraft, CommandParameter, CommandRecord, ImportRisk } from './index.ts';

export interface BookmarkExport {
	format: 'cmdmark-bookmarks';
	version: 1;
	commands: CommandDraft[];
}

const RISK_RULES: Array<{ name: string; pattern: RegExp }> = [
	{ name: 'recursive force delete (rm -rf)', pattern: /\brm\s+-[a-z]*r[a-z]*f[a-z]*(?:\s|$)/i },
	{ name: 'remote script piped to a shell', pattern: /\b(?:curl|wget)\b[^\n|]*\|\s*(?:sh|bash)\b/i }
];

export function serializeBookmarks(commands: CommandRecord[]): string {
	const bundle: BookmarkExport = {
		format: 'cmdmark-bookmarks',
		version: 1,
		commands: commands.map(({ name, command, description, cwd, env, shell, tags, favorite, params }) => ({
			name,
			command,
			description,
			cwd,
			env,
			shell,
			tags,
			favorite,
			params
		}))
	};
	return `${JSON.stringify(bundle, null, 2)}\n`;
}

export function parseBookmarkExport(json: string): CommandDraft[] {
	if (Buffer.byteLength(json, 'utf8') > 10 * 1024 * 1024) throw new RangeError('bookmark export exceeds 10 MiB');
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch (error) {
		throw new TypeError('bookmark export is not valid JSON', { cause: error });
	}
	if (!isRecord(value) || value.format !== 'cmdmark-bookmarks' || value.version !== 1 || !Array.isArray(value.commands)) {
		throw new TypeError('unsupported bookmark export format or version');
	}
	if (value.commands.length > 5000) throw new RangeError('bookmark export contains too many commands');
	return value.commands.map((command, index) => parseCommandDraft(command, index));
}

export function findImportRisks(commands: CommandDraft[]): ImportRisk[] {
	return commands.flatMap((command) => {
		const patterns = RISK_RULES.filter((rule) => rule.pattern.test(command.command)).map((rule) => rule.name);
		return patterns.length === 0 ? [] : [{ name: command.name, command: command.command, patterns }];
	});
}

function parseCommandDraft(value: unknown, index: number): CommandDraft {
	if (!isRecord(value)) throw new TypeError(`command ${index + 1} must be an object`);
	if (typeof value.name !== 'string' || !value.name.trim()) throw new TypeError(`command ${index + 1} needs a name`);
	if (typeof value.command !== 'string' || !value.command.trim()) throw new TypeError(`command ${index + 1} needs a command string`);
	if (value.description !== undefined && typeof value.description !== 'string') throw new TypeError(`command ${index + 1} has an invalid description`);
	if (value.cwd !== undefined && value.cwd !== null && typeof value.cwd !== 'string') throw new TypeError(`command ${index + 1} has an invalid working directory`);
	if (value.shell !== undefined && typeof value.shell !== 'string') throw new TypeError(`command ${index + 1} has an invalid shell`);
	if (value.favorite !== undefined && typeof value.favorite !== 'boolean') throw new TypeError(`command ${index + 1} has an invalid favorite flag`);
	const env = value.env ?? {};
	if (!isRecord(env) || !Object.values(env).every((item) => typeof item === 'string')) throw new TypeError(`command ${index + 1} has invalid environment values`);
	const tags = value.tags ?? [];
	if (!Array.isArray(tags) || !tags.every((tag) => typeof tag === 'string')) throw new TypeError(`command ${index + 1} has invalid tags`);
	const params = value.params ?? [];
	if (!Array.isArray(params) || !params.every(isParameter)) throw new TypeError(`command ${index + 1} has invalid parameters`);
	return {
		name: value.name,
		command: value.command,
		description: typeof value.description === 'string' ? value.description : '',
		cwd: value.cwd === null ? null : typeof value.cwd === 'string' ? value.cwd : null,
		env: env as Record<string, string>,
		shell: typeof value.shell === 'string' ? value.shell : undefined,
		tags: tags as string[],
		favorite: value.favorite === true,
		params: params as CommandParameter[]
	};
}

function isParameter(value: unknown): value is CommandParameter {
	return isRecord(value) &&
		typeof value.name === 'string' &&
		(value.default === undefined || typeof value.default === 'string') &&
		(value.promptLabel === undefined || typeof value.promptLabel === 'string');
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}
