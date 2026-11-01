import { chmod, lstat, mkdir, readFile, readlink, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const outputDirectory = join(import.meta.dir, '../../dist');
const executable = join(outputDirectory, process.platform === 'win32' ? 'cmdmark.exe' : 'cmdmark');
await mkdir(outputDirectory, { recursive: true });

const result = await Bun.build({
	entrypoints: ['./src/main.ts'],
	target: 'bun',
	minify: true,
	throw: false,
	compile: {
		outfile: executable,
		autoloadBunfig: false,
		autoloadDotenv: false
	}
});

if (!result.success) {
	for (const log of result.logs) console.error(log);
	process.exit(1);
}

if (process.platform === 'linux') {
	const daemonAlias = join(outputDirectory, 'cmdmarkd');
	try {
		const existing = await lstat(daemonAlias);
		if (existing.isSymbolicLink()) {
			if (await readlink(daemonAlias) !== 'cmdmark') throw new Error(`refusing to replace user symlink ${daemonAlias}`);
			await unlink(daemonAlias);
		} else {
			const content = await readFile(daemonAlias, 'utf8').catch(() => '');
			if (!content.startsWith('#!/bin/sh\n# cmdmarkd alias')) throw new Error(`refusing to replace existing file ${daemonAlias}`);
		}
	} catch (error) {
		if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT')) throw error;
	}
	await writeFile(daemonAlias, '#!/bin/sh\n# cmdmarkd alias: delegate to the single cmdmark binary\nexec "$(dirname -- "$0")/cmdmark" daemon --foreground "$@"\n', { mode: 0o755 });
	await chmod(daemonAlias, 0o755);
}

console.log(`built ${executable}`);
