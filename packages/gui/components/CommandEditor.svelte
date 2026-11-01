<script lang="ts">
    import { untrack } from 'svelte';
    import type { CommandDraft, CommandRecord, CommandParameter } from '@cmdmark/protocol';
    import ActionButton from './ActionButton.svelte';
    import Field from './TextField.svelte';
    import Modal from './Modal.svelte';

    interface Props {
        command: CommandRecord | null;
        initialCommand?: string;
        onSave: (draft: CommandDraft) => Promise<void>;
        onClose: () => void;
    }

    let { command, initialCommand = '', onSave, onClose }: Props = $props();
    const initial = untrack(() => ({
        name: command?.name ?? '',
        command: command?.command ?? initialCommand,
        description: command?.description ?? '',
        cwd: command?.cwd ?? '',
        shell: command?.shell ?? '',
        env: Object.entries(command?.env ?? {}).map(([key, value]) => `${key}=${value}`).join('\n'),
        tags: (command?.tags ?? []).join(', '),
        params: (command?.params ?? []).map((parameter) => {
            const label = parameter.promptLabel && parameter.promptLabel !== parameter.name ? `|${parameter.promptLabel}` : '';
            return `${parameter.name}${label}${parameter.default === undefined ? '' : `=${parameter.default}`}`;
        }).join('\n')
    }));
    let name = $state(initial.name);
    let commandText = $state(initial.command);
    let description = $state(initial.description);
    let cwd = $state(initial.cwd);
    let shell = $state(initial.shell);
    let envText = $state(initial.env);
    let tagsText = $state(initial.tags);
    let paramsText = $state(initial.params);
    let saving = $state(false);
    let error = $state('');

    async function save() {
        error = '';
        const env: Record<string, string> = {};
        for (const line of envText.split('\n')) {
            if (!line.trim()) continue;
            const splitAt = line.indexOf('=');
            if (splitAt < 1) {
                error = `Environment entries use KEY=value: ${line}`;
                return;
            }
            env[line.slice(0, splitAt).trim()] = line.slice(splitAt + 1);
        }
        const params: CommandParameter[] = [];
        for (const line of paramsText.split('\n')) {
            const entry = line.trim();
            if (!entry) continue;
            const defaultSplit = entry.indexOf('=');
            const declaration = (defaultSplit < 0 ? entry : entry.slice(0, defaultSplit)).trim();
            const labelSplit = declaration.indexOf('|');
            const parameterName = (labelSplit < 0 ? declaration : declaration.slice(0, labelSplit)).trim();
            const promptLabel = (labelSplit < 0 ? parameterName : declaration.slice(labelSplit + 1)).trim();
            params.push({
                name: parameterName,
                promptLabel,
                ...(defaultSplit < 0 ? {} : { default: entry.slice(defaultSplit + 1) })
            });
        }
        const draft: CommandDraft = {
            name: name.trim(),
            command: commandText,
            description: description.trim(),
            cwd: cwd.trim() || null,
            shell: shell.trim() || undefined,
            env,
            tags: tagsText.split(/[\n,]/).map((tag) => tag.trim()).filter(Boolean),
            params
        };
        if (!draft.name || !draft.command.trim()) {
            error = 'Name and command are required.';
            return;
        }
        saving = true;
        try {
            await onSave(draft);
        } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
        } finally {
            saving = false;
        }
    }
</script>

<Modal title={command ? 'Edit bookmark' : 'New bookmark'} onClose={onClose} width={660} height={680} eyebrow="COMMAND LIBRARY">
    <Field label="Name" value={name} onchange={(value) => (name = value)} placeholder="Build the project" testId="command-name" />
    <Field label="Shell command" value={commandText} onchange={(value) => (commandText = value)} placeholder="bun run build" multiline rows={4} testId="command-text" hint="Parameters become individually quoted shell words. Resolved commands are kept in run history—use $VAR for secrets instead." />
    <Field label="Description" value={description} onchange={(value) => (description = value)} placeholder="What this command is for" multiline rows={2} />
    <div class="two-fields">
        <div class="field-half"><Field label="Working directory" value={cwd} onchange={(value) => (cwd = value)} placeholder="Use the caller's current directory" /></div>
        <div class="field-half"><Field label="Shell" value={shell} onchange={(value) => (shell = value)} placeholder="$SHELL" /></div>
    </div>
    <div class="two-fields">
        <div class="field-half"><Field label="Environment (one KEY=value per line)" value={envText} onchange={(value) => (envText = value)} placeholder="NODE_ENV=development" multiline rows={3} /></div>
        <div class="field-half"><Field label="Tags (comma separated)" value={tagsText} onchange={(value) => (tagsText = value)} placeholder="build, local" multiline rows={3} /></div>
    </div>
    <Field label="Parameters (name|prompt label=default)" value={paramsText} onchange={(value) => (paramsText = value)} placeholder="target|Target platform=linux\nprofile|Build profile" multiline rows={3} hint="Each value is shell-quoted before insertion. Omit =default to prompt at run time." />
    {#if error}<text class="error">{error}</text>{/if}
    <div class="footer">
        <text class="footer-hint">Nothing runs until you choose Run.</text>
        <div class="actions">
            <ActionButton label="Cancel" kind="outline" onclick={onClose} />
            <ActionButton label={saving ? 'Saving…' : 'Save bookmark'} kind="primary" disabled={saving} onclick={save} testId="save-command" />
        </div>
    </div>
</Modal>

<style>
    .two-fields { display: flex; flex-direction: row; align-items: start; gap: 14px; width: 100%; }
    .field-half { flex-grow: 1; flex-basis: 0; min-width: 0; }
    .error { color: var(--danger); font-size: 13px; }
    .footer { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 16px; padding-top: 8px; }
    .footer-hint { color: var(--ink-muted); font-size: 11px; }
    .actions { display: flex; flex-direction: row; align-items: center; gap: 8px; }
</style>
