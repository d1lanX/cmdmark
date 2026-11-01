export type RpcId = string | number;

export type RunState =
	| 'starting'
	| 'running'
	| 'stopped'
	| 'exited'
	| 'killed'
	| 'failed'
	| 'lost';

export type RunSignal = 'SIGINT' | 'SIGTERM' | 'SIGKILL' | 'SIGSTOP' | 'SIGCONT';

export interface CommandParameter {
	name: string;
	default?: string;
	promptLabel?: string;
}

export interface CommandRecord {
	id: string;
	name: string;
	command: string;
	description: string;
	cwd: string | null;
	env: Record<string, string>;
	shell: string;
	tags: string[];
	favorite: boolean;
	createdAt: number;
	updatedAt: number;
	lastUsedAt: number | null;
	useCount: number;
	params: CommandParameter[];
}

export interface RunRecord {
	runId: string;
	commandId: string | null;
	resolvedCommand: string;
	cwd: string | null;
	pid: number | null;
	pgid: number | null;
	procStartTime: string | null;
	state: RunState;
	startedAt: number;
	endedAt: number | null;
	exitCode: number | null;
	signal: string | null;
	logPath: string;
}

export interface CommandDraft {
	name: string;
	command: string;
	description?: string;
	cwd?: string | null;
	env?: Record<string, string>;
	shell?: string;
	tags?: string[];
	favorite?: boolean;
	params?: CommandParameter[];
}

export type CommandPatch = Partial<CommandDraft>;

export interface SearchHit {
	command: CommandRecord;
	score: number;
}

export interface ImportRisk {
	name: string;
	command: string;
	patterns: string[];
}

export interface SettingsRecord {
	terminal: string | null;
	defaultShell: string;
	gracePeriodMs: number;
	bufferSizeBytes: number;
	attachDetachKey: string;
}

export interface RpcParams {
	'daemon.ping': Record<string, never>;
	'commands.list': { tag?: string; favorite?: boolean };
	'commands.get': { id: string };
	'commands.create': { command: CommandDraft };
	'commands.update': { id: string; patch: CommandPatch };
	'commands.delete': { id: string };
	'commands.duplicate': { id: string };
	'commands.favorite': { id: string; favorite: boolean };
	'commands.search': { query: string; tag?: string };
	'commands.export': Record<string, never>;
	'commands.importPreview': { json: string };
	'commands.import': { commands: CommandDraft[] };
	'runs.list': { state?: RunState };
	'runs.get': { runId: string };
	'runs.delete': { runId: string };
	'runs.clearHistory': Record<string, never>;
	'runs.start': {
		commandId?: string;
		command?: string;
		name?: string;
		cwd?: string | null;
		shell?: string;
		env?: Record<string, string>;
		params?: Record<string, string>;
	};
	'runs.stop': { runId: string; gracePeriodMs?: number };
	'runs.signal': { runId: string; signal: RunSignal };
	'runs.restart': { runId: string };
	'runs.logs': { runId: string; offset?: number; limit?: number };
	'runs.subscribe': { runId?: string; includeOutput?: boolean };
	'runs.unsubscribe': { subscriptionId: string };
	'runs.attach': { runId: string; cols: number; rows: number };
	'runs.write': { runId: string; dataBase64: string };
	'runs.resize': { runId: string; cols: number; rows: number };
	'runs.detach': { runId: string };
	'settings.get': Record<string, never>;
	'settings.update': { patch: Partial<SettingsRecord> };
}

export interface RpcResults {
	'daemon.ping': { version: string; pid: number };
	'commands.list': { commands: CommandRecord[] };
	'commands.get': { command: CommandRecord | null };
	'commands.create': { command: CommandRecord };
	'commands.update': { command: CommandRecord };
	'commands.delete': { deleted: boolean };
	'commands.duplicate': { command: CommandRecord };
	'commands.favorite': { command: CommandRecord };
	'commands.search': { hits: SearchHit[]; fts5: boolean };
	'commands.export': { json: string };
	'commands.importPreview': { commands: CommandDraft[]; risks: ImportRisk[] };
	'commands.import': { commands: CommandRecord[]; risks: ImportRisk[] };
	'runs.list': { runs: RunRecord[] };
	'runs.get': { run: RunRecord | null };
	'runs.delete': { deleted: boolean };
	'runs.clearHistory': { deletedRunIds: string[]; failedRunIds: string[] };
	'runs.start': { run: RunRecord };
	'runs.stop': { run: RunRecord };
	'runs.signal': { run: RunRecord };
	'runs.restart': { run: RunRecord };
	'runs.logs': { dataBase64: string; nextOffset: number; truncated: boolean };
	'runs.subscribe': { subscriptionId: string };
	'runs.unsubscribe': { unsubscribed: boolean };
	'runs.attach': { attached: boolean; offset: number; initialOutputBase64: string };
	'runs.write': { written: boolean };
	'runs.resize': { resized: boolean };
	'runs.detach': { detached: boolean };
	'settings.get': { settings: SettingsRecord };
	'settings.update': { settings: SettingsRecord };
}

export type RpcMethod = keyof RpcParams;

export type RpcRequest = {
	[M in RpcMethod]: {
		jsonrpc: '2.0';
		id: RpcId;
		method: M;
		params: RpcParams[M];
	};
}[RpcMethod];

export type RpcSuccessResponse = {
	[M in RpcMethod]: {
		jsonrpc: '2.0';
		id: RpcId;
		result: RpcResults[M];
	};
}[RpcMethod];

export interface RpcErrorObject {
	code: number;
	message: string;
	data?: unknown;
}

export interface RpcErrorResponse {
	jsonrpc: '2.0';
	id: RpcId | null;
	error: RpcErrorObject;
}

export type RpcResponse = RpcSuccessResponse | RpcErrorResponse;

export interface RunStateNotification {
	jsonrpc: '2.0';
	method: 'run.state';
	params: { run: RunRecord };
}

export interface RunOutputNotification {
	jsonrpc: '2.0';
	method: 'run.output';
	params: { runId: string; offset: number; dataBase64: string };
}

export interface RunsDeletedNotification {
	jsonrpc: '2.0';
	method: 'runs.deleted';
	params: { runIds: string[] };
}

export interface CommandsChangedNotification {
	jsonrpc: '2.0';
	method: 'commands.changed';
	params: { commandId: string; change: 'created' | 'updated' | 'deleted' };
}

export interface SettingsChangedNotification {
	jsonrpc: '2.0';
	method: 'settings.changed';
	params: { settings: SettingsRecord };
}

export type RpcNotification =
	| RunStateNotification
	| RunOutputNotification
	| RunsDeletedNotification
	| CommandsChangedNotification
	| SettingsChangedNotification;

export type RpcMessage = RpcRequest | RpcResponse | RpcNotification;

export const RPC_METHODS = [
	'daemon.ping',
	'commands.list',
	'commands.get',
	'commands.create',
	'commands.update',
	'commands.delete',
	'commands.duplicate',
	'commands.favorite',
	'commands.search',
	'commands.export',
	'commands.importPreview',
	'commands.import',
	'runs.list',
	'runs.get',
	'runs.delete',
	'runs.clearHistory',
	'runs.start',
	'runs.stop',
	'runs.signal',
	'runs.restart',
	'runs.logs',
	'runs.subscribe',
	'runs.unsubscribe',
	'runs.attach',
	'runs.write',
	'runs.resize',
	'runs.detach',
	'settings.get',
	'settings.update'
] as const satisfies readonly RpcMethod[];

const RPC_METHOD_SET: ReadonlySet<string> = new Set(RPC_METHODS);
const NOTIFICATION_METHODS: ReadonlySet<string> = new Set([
	'run.state',
	'run.output',
	'runs.deleted',
	'commands.changed',
	'settings.changed'
]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isRpcId(value: unknown): value is RpcId {
	return typeof value === 'string' || (typeof value === 'number' && Number.isFinite(value));
}

function validParams(method: RpcMethod, params: Record<string, unknown>): boolean {
	const hasString = (key: string) => typeof params[key] === 'string';
	const optionalString = (key: string) => params[key] === undefined || typeof params[key] === 'string';
	const optionalNullableString = (key: string) => params[key] === undefined || params[key] === null || typeof params[key] === 'string';
	const optionalBoolean = (key: string) => params[key] === undefined || typeof params[key] === 'boolean';
	const optionalInteger = (key: string, min = 0) => params[key] === undefined || (numberIsInteger(params[key]) && params[key] >= min);
	const stringMap = (value: unknown) => isRecord(value) && Object.values(value).every((entry) => typeof entry === 'string');

	switch (method) {
		case 'daemon.ping':
		case 'settings.get':
			return true;
		case 'commands.list':
			return optionalString('tag') && optionalBoolean('favorite');
		case 'commands.get':
		case 'commands.delete':
		case 'commands.duplicate':
			return hasString('id');
		case 'commands.create':
			return isCommandDraft(params.command, false);
		case 'commands.update':
			return hasString('id') && isCommandDraft(params.patch, true);
		case 'commands.favorite':
			return hasString('id') && typeof params.favorite === 'boolean';
		case 'commands.search':
			return hasString('query') && optionalString('tag');
		case 'commands.export':
			return true;
		case 'commands.importPreview':
			return hasString('json');
		case 'commands.import':
			return Array.isArray(params.commands) && params.commands.every((command) => isCommandDraft(command, false));
		case 'runs.list':
			return params.state === undefined || isRunState(params.state);
		case 'runs.get':
		case 'runs.delete':
			return hasString('runId');
		case 'runs.clearHistory':
			return true;
		case 'runs.start':
			return optionalString('commandId') && optionalString('command') && optionalString('name') &&
				optionalNullableString('cwd') && optionalString('shell') &&
				(params.env === undefined || stringMap(params.env)) &&
				(params.params === undefined || stringMap(params.params)) &&
				(Boolean(params.commandId) || Boolean(params.command));
		case 'runs.stop':
			return hasString('runId') && optionalInteger('gracePeriodMs');
		case 'runs.signal':
			return hasString('runId') && isRunSignal(params.signal);
		case 'runs.restart':
			return hasString('runId');
		case 'runs.logs':
			return hasString('runId') && optionalInteger('offset') && optionalInteger('limit', 1);
		case 'runs.subscribe':
			return optionalString('runId') && optionalBoolean('includeOutput');
		case 'runs.unsubscribe':
			return hasString('subscriptionId');
		case 'runs.attach':
			return hasString('runId') && numberIsInteger(params.cols) && params.cols > 0 &&
				numberIsInteger(params.rows) && params.rows > 0;
		case 'runs.write':
			return hasString('runId') && hasString('dataBase64') && isBase64(params.dataBase64);
		case 'runs.resize':
			return hasString('runId') && numberIsInteger(params.cols) && params.cols > 0 &&
				numberIsInteger(params.rows) && params.rows > 0;
		case 'runs.detach':
			return hasString('runId');
		case 'settings.update':
			return isRecord(params.patch);
	}
}

function isCommandDraft(value: unknown, partial: boolean): boolean {
	if (!isRecord(value)) return false;
	if (!partial && (typeof value.name !== 'string' || typeof value.command !== 'string')) return false;
	if (value.name !== undefined && typeof value.name !== 'string') return false;
	if (value.command !== undefined && typeof value.command !== 'string') return false;
	if (value.description !== undefined && typeof value.description !== 'string') return false;
	if (value.cwd !== undefined && value.cwd !== null && typeof value.cwd !== 'string') return false;
	if (value.shell !== undefined && typeof value.shell !== 'string') return false;
	if (value.favorite !== undefined && typeof value.favorite !== 'boolean') return false;
	if (value.env !== undefined && !(isRecord(value.env) && Object.values(value.env).every((entry) => typeof entry === 'string'))) return false;
	if (value.tags !== undefined && !(Array.isArray(value.tags) && value.tags.every((entry) => typeof entry === 'string'))) return false;
	if (value.params !== undefined && !(Array.isArray(value.params) && value.params.every((entry) => isRecord(entry) && typeof entry.name === 'string'))) return false;
	return true;
}

function validNotificationParams(method: string, params: Record<string, unknown>): boolean {
	switch (method) {
		case 'run.state':
			return isRecord(params.run) && typeof params.run.runId === 'string' && isRunState(params.run.state);
		case 'run.output':
			return typeof params.runId === 'string' && numberIsInteger(params.offset) &&
				typeof params.dataBase64 === 'string' && isBase64(params.dataBase64);
		case 'runs.deleted':
			return Array.isArray(params.runIds) && params.runIds.every((runId) => typeof runId === 'string');
		case 'commands.changed':
			return typeof params.commandId === 'string' && ['created', 'updated', 'deleted'].includes(String(params.change));
		case 'settings.changed':
			return isRecord(params.settings);
		default:
			return false;
	}
}

function numberIsInteger(value: unknown): value is number {
	return typeof value === 'number' && Number.isInteger(value);
}

function isRunState(value: unknown): value is RunState {
	return ['starting', 'running', 'stopped', 'exited', 'killed', 'failed', 'lost'].includes(String(value));
}

function isRunSignal(value: unknown): value is RunSignal {
	return ['SIGINT', 'SIGTERM', 'SIGKILL', 'SIGSTOP', 'SIGCONT'].includes(String(value));
}

function isBase64(value: unknown): value is string {
	return typeof value === 'string' && /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value);
}

export function isRpcRequest(value: unknown): value is RpcRequest {
	return (
		isRecord(value) &&
		value.jsonrpc === '2.0' &&
		isRpcId(value.id) &&
		typeof value.method === 'string' &&
		RPC_METHOD_SET.has(value.method) &&
		isRecord(value.params) &&
		validParams(value.method as RpcMethod, value.params)
	);
}

export function isRpcNotification(value: unknown): value is RpcNotification {
	return (
		isRecord(value) &&
		value.jsonrpc === '2.0' &&
		!('id' in value) &&
		typeof value.method === 'string' &&
		NOTIFICATION_METHODS.has(value.method) &&
		isRecord(value.params) &&
		validNotificationParams(value.method, value.params)
	);
}

export function isRpcResponse(value: unknown): value is RpcResponse {
	if (!isRecord(value) || value.jsonrpc !== '2.0' || !(value.id === null || isRpcId(value.id))) return false;
	if ('error' in value) return isRecord(value.error) && typeof value.error.code === 'number' && typeof value.error.message === 'string';
	return 'result' in value;
}

export function parseRpcMessage(json: string): RpcMessage {
	const value: unknown = JSON.parse(json);
	if (isRpcRequest(value) || isRpcNotification(value) || isRpcResponse(value)) return value;
	throw new TypeError('Invalid JSON-RPC 2.0 message');
}

export function errorResponse(id: RpcId | null, code: number, message: string, data?: unknown): RpcErrorResponse {
	return {
		jsonrpc: '2.0',
		id,
		error: data === undefined ? { code, message } : { code, message, data }
	};
}
