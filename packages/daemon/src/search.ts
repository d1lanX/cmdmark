import type { CommandRecord, SearchHit } from '@cmdmark/protocol';

export interface RankedCommand {
	command: CommandRecord;
	ftsRank: number;
}

const DAY_MS = 86_400_000;

export function toFtsQuery(query: string): string {
	const terms = query.normalize('NFKD').match(/[\p{L}\p{N}_-]+/gu) ?? [];
	return terms.map((term) => `"${term.replaceAll('"', '""')}"`).join(' OR ');
}

export function rankFtsResults(results: RankedCommand[], now = Date.now()): SearchHit[] {
	if (results.length === 0) return [];
	const ranks = results.map((result) => result.ftsRank);
	const best = Math.min(...ranks);
	const worst = Math.max(...ranks);

	return results
		.map(({ command, ftsRank }) => {
			const relevance = best === worst ? 1 : (worst - ftsRank) / (worst - best);
			return { command, score: relevance + preferenceBoost(command, now) };
		})
		.sort(compareHits);
}

export function rankFuzzyResults(commands: CommandRecord[], query: string, now = Date.now()): SearchHit[] {
	const hits: SearchHit[] = [];
	for (const command of commands) {
		const score = fuzzyScore(query, [command.name, command.command, command.description, ...command.tags]);
		if (score < 0.18) continue;
		hits.push({ command, score: score + preferenceBoost(command, now) });
	}
	return hits.sort(compareHits);
}

export function fuzzyScore(query: string, fields: string[]): number {
	const normalizedQuery = normalize(query);
	if (!normalizedQuery) return 0;
	const normalizedFields = fields.map(normalize).filter(Boolean);
	if (normalizedFields.some((field) => field.includes(normalizedQuery))) return 1;

	const tokens = normalizedQuery.split(/\s+/).filter(Boolean);
	if (tokens.length === 0 || normalizedFields.length === 0) return 0;
	const words = normalizedFields.flatMap((field) => field.split(/[^\p{L}\p{N}_-]+/u)).filter(Boolean);
	if (words.length === 0) return 0;

	let total = 0;
	for (const token of tokens) {
		let best = 0;
		for (const word of words) {
			if (word.includes(token)) {
				best = Math.max(best, word.startsWith(token) ? 0.92 : 0.8);
				continue;
			}
			if (token.length < 4) continue;
			const distance = levenshtein(token, word);
			const allowed = Math.max(1, Math.floor(token.length * 0.34));
			if (distance <= allowed) best = Math.max(best, 0.72 * (1 - distance / Math.max(token.length, word.length)));
		}
		total += best;
	}
	return total / tokens.length;
}

export function levenshtein(left: string, right: string): number {
	if (left === right) return 0;
	if (left.length === 0) return right.length;
	if (right.length === 0) return left.length;

	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let i = 0; i < left.length; i++) {
		const current = [i + 1];
		for (let j = 0; j < right.length; j++) {
			const substitution = previous[j] + (left[i] === right[j] ? 0 : 1);
			current.push(Math.min(current[j] + 1, previous[j + 1] + 1, substitution));
		}
		previous = current;
	}
	return previous[right.length];
}

function preferenceBoost(command: CommandRecord, now: number): number {
	const favorite = command.favorite ? 0.15 : 0;
	const daysSinceUse = command.lastUsedAt === null ? Infinity : Math.max(0, (now - command.lastUsedAt) / DAY_MS);
	const recent = Number.isFinite(daysSinceUse) ? 0.1 * Math.exp(-daysSinceUse / 30) : 0;
	return favorite + recent;
}

function compareHits(left: SearchHit, right: SearchHit): number {
	return right.score - left.score || right.command.updatedAt - left.command.updatedAt || left.command.name.localeCompare(right.command.name);
}

function normalize(value: string): string {
	return value.normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLocaleLowerCase().trim();
}
