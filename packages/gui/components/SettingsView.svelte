<script lang="ts">
    import { untrack } from 'svelte';
    import type { SettingsRecord } from '@cmdmark/protocol';
    import Scroller from 'gpuix-svelte/components/Scroller.svelte';
    import ActionButton from './ActionButton.svelte';
    import Field from './TextField.svelte';

    interface Props {
        settings: SettingsRecord;
        onSave: (patch: Partial<SettingsRecord>) => Promise<void>;
        onExport: (path: string) => Promise<void>;
        onImport: (path: string) => Promise<void>;
    }

    let { settings, onSave, onExport, onImport }: Props = $props();
    const initial = untrack(() => ({
        terminal: settings.terminal ?? '',
        defaultShell: settings.defaultShell,
        graceSeconds: String(Math.round(settings.gracePeriodMs / 1000)),
        bufferKilobytes: String(Math.round(settings.bufferSizeBytes / 1024)),
        attachDetachKey: settings.attachDetachKey
    }));
    let terminal = $state(initial.terminal);
    let defaultShell = $state(initial.defaultShell);
    let graceSeconds = $state(initial.graceSeconds);
    let bufferKilobytes = $state(initial.bufferKilobytes);
    let attachDetachKey = $state(initial.attachDetachKey);
    let exportPath = $state('');
    let importPath = $state('');
    let saving = $state(false);
    let error = $state('');
    let saved = $state(false);
    let transferMessage = $state('');

    async function save() {
        error = '';
        saved = false;
        const grace = Number(graceSeconds);
        const buffer = Number(bufferKilobytes);
        if (!Number.isInteger(grace) || grace < 0 || grace > 600) {
            error = 'Grace period must be between 0 and 600 seconds.';
            return;
        }
        if (!Number.isInteger(buffer) || buffer < 1 || buffer > 65536) {
            error = 'Buffer size must be between 1 and 65536 KB.';
            return;
        }
        saving = true;
        try {
            await onSave({
                terminal: terminal.trim() || null,
                defaultShell: defaultShell.trim() || '/bin/sh',
                gracePeriodMs: grace * 1000,
                bufferSizeBytes: buffer * 1024,
                attachDetachKey: attachDetachKey.trim() || 'ctrl-]'
            });
            saved = true;
        } catch (caught) {
            error = caught instanceof Error ? caught.message : String(caught);
        } finally {
            saving = false;
        }
    }

    async function exportJson() {
        transferMessage = '';
        if (!exportPath.trim()) {
            transferMessage = 'Choose a file path for the JSON export.';
            return;
        }
        try {
            await onExport(exportPath.trim());
            transferMessage = 'Bookmarks exported. The file is private to your user.';
        } catch (caught) {
            transferMessage = caught instanceof Error ? caught.message : String(caught);
        }
    }

    async function reviewImport() {
        transferMessage = '';
        if (!importPath.trim()) {
            transferMessage = 'Choose a JSON file to review.';
            return;
        }
        try {
            await onImport(importPath.trim());
        } catch (caught) {
            transferMessage = caught instanceof Error ? caught.message : String(caught);
        }
    }
</script>

<Scroller gap={18} pad="0 10px 8px 0" testid="settings-scroll">
<div class="settings">
    <div class="section-head">
        <text class="eyebrow">PREFERENCES</text>
        <text class="section-title">Runtime settings</text>
        <text class="section-copy">These preferences are stored by cmdmarkd and apply to future runs.</text>
    </div>
    <div class="settings-form">
        <Field label="Terminal emulator" value={terminal} onchange={(value) => (terminal = value)} placeholder="Auto-detect (e.g. kitty, foot, gnome-terminal)" hint="Leave blank to detect from $TERMINAL and the installed desktop terminal." />
        <Field label="Default shell" value={defaultShell} onchange={(value) => (defaultShell = value)} placeholder="/bin/bash" />
        <div class="two-fields">
            <div class="field-half"><Field label="Stop grace period (seconds)" value={graceSeconds} onchange={(value) => (graceSeconds = value)} /></div>
            <div class="field-half"><Field label="PTY ring buffer (KB)" value={bufferKilobytes} onchange={(value) => (bufferKilobytes = value)} /></div>
        </div>
        <Field label="Detach key sequence" value={attachDetachKey} onchange={(value) => (attachDetachKey = value)} placeholder="ctrl-]" hint="Used by cmdmark attach; press the sequence to leave without stopping the run." />
        {#if error}<text class="error">{error}</text>{/if}
        {#if saved}<text class="saved">Settings saved.</text>{/if}
        <div class="actions"><ActionButton label={saving ? 'Saving…' : 'Save settings'} kind="primary" disabled={saving} onclick={save} testId="save-settings" /></div>
    </div>
    <div class="backup-panel">
        <text class="backup-title">Bookmark archive</text>
        <text class="section-copy">JSON exports contain saved commands and parameters only. Imported commands are never run automatically.</text>
        <div class="transfer-row">
            <div class="path-field"><Field label="Export path" value={exportPath} onchange={(value) => (exportPath = value)} placeholder="/home/me/cmdmark-bookmarks.json" testId="export-path" /></div>
            <ActionButton label="Export JSON" kind="outline" onclick={exportJson} testId="export-bookmarks" />
        </div>
        <div class="transfer-row">
            <div class="path-field"><Field label="Import path" value={importPath} onchange={(value) => (importPath = value)} placeholder="/home/me/cmdmark-bookmarks.json" testId="import-path" /></div>
            <ActionButton label="Review import" kind="outline" onclick={reviewImport} testId="review-import" />
        </div>
        {#if transferMessage}<text class="transfer-message">{transferMessage}</text>{/if}
    </div>
</div>
</Scroller>

<style>
    .settings { display: flex; flex-direction: column; flex-grow: 1; gap: 24px; max-width: 760px; padding: 10px 4px; }
    .section-head { display: flex; flex-direction: column; gap: 7px; }
    .eyebrow { color: var(--accent); font-size: 10px; font-weight: 800; }
    .section-title { color: var(--ink); font-size: 24px; font-weight: 700; }
    .section-copy { color: var(--ink-muted); font-size: 13px; }
    .settings-form { display: flex; flex-direction: column; gap: 18px; padding: 22px; border-radius: 7px; background-color: var(--paper); }
    .backup-panel { display: flex; flex-direction: column; gap: 14px; padding: 20px 22px; border-radius: 7px; background-color: var(--paper); }
    .backup-title { color: var(--ink); font-size: 16px; font-weight: 700; }
    .transfer-row { display: flex; flex-direction: row; align-items: end; gap: 12px; }
    .path-field { flex-grow: 1; min-width: 0; }
    .transfer-message { color: var(--ink-muted); font-size: 11px; }
    .two-fields { display: flex; flex-direction: row; gap: 16px; }
    .field-half { flex-grow: 1; flex-basis: 0; min-width: 0; }
    .error { color: var(--danger); font-size: 12px; }
    .saved { color: var(--success-ink); font-size: 12px; font-weight: 700; }
    .actions { display: flex; flex-direction: row; justify-content: end; padding-top: 4px; }
</style>
