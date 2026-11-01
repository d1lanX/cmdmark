import { describe, expect, test } from 'bun:test';
import { findImportRisks, parseBookmarkExport, serializeBookmarks } from '../src/bookmarks.ts';
import type { CommandRecord } from '../src/index.ts';

const command: CommandRecord = {
	id: 'run-not-exported',
	name: 'Build',
	command: 'bun run build',
	description: 'Compile locally',
	cwd: null,
	env: { CI: '1' },
	shell: '/bin/bash',
	tags: ['dev'],
	favorite: true,
	createdAt: 1,
	updatedAt: 2,
	lastUsedAt: null,
	useCount: 4,
	params: [{ name: 'target', default: 'linux', promptLabel: 'Platform' }]
};

describe('bookmark JSON import/export', () => {
	test('exports only bookmark data and round-trips supported fields', () => {
		const json = serializeBookmarks([command]);
		const drafts = parseBookmarkExport(json);
		expect(json).not.toContain('run-not-exported');
		expect(drafts).toEqual([{
			name: 'Build',
			command: 'bun run build',
			description: 'Compile locally',
			cwd: null,
			env: { CI: '1' },
			shell: '/bin/bash',
			tags: ['dev'],
			favorite: true,
			params: [{ name: 'target', default: 'linux', promptLabel: 'Platform' }]
		}]);
	});

	test('rejects unsupported versions and malformed command records', () => {
		expect(() => parseBookmarkExport('{')).toThrow('not valid JSON');
		expect(() => parseBookmarkExport(JSON.stringify({ format: 'cmdmark-bookmarks', version: 99, commands: [] }))).toThrow('unsupported');
		expect(() => parseBookmarkExport(JSON.stringify({ format: 'cmdmark-bookmarks', version: 1, commands: [{ name: 'missing command' }] }))).toThrow('needs a command');
	});

	test('flags risky patterns without running imported commands', () => {
		const drafts = parseBookmarkExport(JSON.stringify({
			format: 'cmdmark-bookmarks',
			version: 1,
			commands: [
				{ name: 'Cleanup', command: 'rm -rf /tmp/build' },
				{ name: 'Install', command: 'curl https://example.invalid/install.sh | sh' },
				{ name: 'Safe', command: 'bun run build' }
			]
		}));
		expect(findImportRisks(drafts).map((risk) => risk.patterns[0])).toEqual([
			'recursive force delete (rm -rf)',
			'remote script piped to a shell'
		]);
	});
});
