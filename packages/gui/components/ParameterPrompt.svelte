<script lang="ts">
    import { untrack } from 'svelte';
    import type { CommandRecord } from '@cmdmark/protocol';
    import { resolveTemplate, templateVariables } from '@cmdmark/protocol/template';
    import ActionButton from './ActionButton.svelte';
    import Field from './TextField.svelte';
    import Modal from './Modal.svelte';

    interface Props {
        command: CommandRecord;
        onRun: (resolvedCommand: string) => Promise<void>;
        onClose: () => void;
    }

    let { command, onRun, onClose }: Props = $props();
    const initial = untrack(() => {
        const variables = templateVariables(command.command, command.params);
        const values = Object.fromEntries(
            variables.filter((variable) => variable.defaultValue !== undefined).map((variable) => [variable.name, variable.defaultValue!])
        );
        return { variables, values };
    });
    const variables = initial.variables;
    let values = $state<Record<string, string>>(initial.values);
    let saving = $state(false);
    let error = $state('');

    function previewCommand(): string {
        try {
            return resolveTemplate(command.command, values, command.params);
        } catch {
            return '';
        }
    }

    let preview = $derived(previewCommand());

    async function run() {
        error = '';
        if (!preview) {
            error = 'Enter a value for every required parameter.';
            return;
        }
        saving = true;
        try {
            await onRun(preview);
        } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
        } finally {
            saving = false;
        }
    }
</script>

<Modal title="Resolve parameters" onClose={onClose} width={600} height={500} eyebrow={command.name.toLocaleUpperCase()}>
    <text class="intro">Values are quoted as single shell words. Run history keeps the resolved command, so use environment variables for secrets.</text>
    {#each variables as variable (variable.name)}
        <Field
            label={variable.label}
            value={values[variable.name] ?? ''}
            onchange={(value) => (values = { ...values, [variable.name]: value })}
            placeholder={variable.defaultValue === undefined ? 'Required value' : variable.defaultValue}
            testId={`parameter-${variable.name}`}
        />
    {/each}
    <div class="preview">
        <text class="preview-label">RESOLVED COMMAND</text>
        <text class="preview-command">{preview || 'Fill in required values to preview.'}</text>
    </div>
    {#if error}<text class="error">{error}</text>{/if}
    <div class="actions">
        <ActionButton label="Cancel" kind="outline" onclick={onClose} />
        <ActionButton label={saving ? 'Starting…' : 'Run command'} kind="primary" disabled={saving || !preview} onclick={run} testId="confirm-run" />
    </div>
</Modal>

<style>
    .intro { color: var(--ink-muted); font-size: 13px; }
    .preview { display: flex; flex-direction: column; gap: 8px; padding: 13px; border-radius: 5px; background-color: var(--code-surface); }
    .preview-label { color: var(--ink-muted); font-size: 10px; font-weight: 800; }
    .preview-command { color: var(--code-ink); font-family: monospace; font-size: 12px; white-space: normal; }
    .error { color: var(--danger); font-size: 12px; }
    .actions { display: flex; flex-direction: row; justify-content: end; gap: 8px; padding-top: 4px; }
</style>
