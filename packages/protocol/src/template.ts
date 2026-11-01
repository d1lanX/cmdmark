import type { CommandParameter } from './index.ts';

export interface TemplateVariable {
	name: string;
	label: string;
	defaultValue?: string;
}

const PLACEHOLDER = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;

export function templateVariables(template: string, parameters: CommandParameter[] = []): TemplateVariable[] {
	const metadata = new Map(parameters.map((parameter) => [parameter.name, parameter]));
	const names = new Set<string>();
	for (const match of template.matchAll(PLACEHOLDER)) names.add(match[1]!);
	return [...names].map((name) => {
		const parameter = metadata.get(name);
		return {
			name,
			label: parameter?.promptLabel || name,
			...(parameter?.default === undefined ? {} : { defaultValue: parameter.default })
		};
	});
}

export function resolveTemplate(
	template: string,
	values: Record<string, string>,
	parameters: CommandParameter[] = []
): string {
	const metadata = new Map(parameters.map((parameter) => [parameter.name, parameter]));
	return template.replace(PLACEHOLDER, (_placeholder, name: string) => {
		const supplied = values[name];
		const value = supplied === undefined ? metadata.get(name)?.default : supplied;
		if (value === undefined) throw new Error(`missing value for template parameter: ${name}`);
		return shellQuote(value);
	});
}

export function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
