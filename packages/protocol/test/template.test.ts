import { describe, expect, test } from 'bun:test';
import { resolveTemplate, shellQuote, templateVariables } from '../src/template.ts';

describe('command templates', () => {
	test('finds unique placeholders and reads labels/defaults from metadata', () => {
		expect(templateVariables('echo {{name}} {{name}} {{target}}', [
			{ name: 'name', promptLabel: 'Project name' },
			{ name: 'target', default: 'linux' }
		])).toEqual([
			{ name: 'name', label: 'Project name' },
			{ name: 'target', label: 'target', defaultValue: 'linux' }
		]);
	});

	test('shell-quotes each substituted value and uses metadata defaults', () => {
		expect(shellQuote("it's ready")).toBe("'it'\\''s ready'");
		expect(resolveTemplate('echo {{name}} {{target}}', { name: 'one; touch /tmp/no' }, [
			{ name: 'target', default: 'release' }
		])).toBe("echo 'one; touch /tmp/no' 'release'");
	});

	test('fails closed when a required template value is absent', () => {
		expect(() => resolveTemplate('echo {{required}}', {})).toThrow('missing value for template parameter: required');
	});
});
