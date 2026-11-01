<script lang="ts">
    import { chmod, readFile, writeFile } from 'node:fs/promises';
    import { on_window_key, set_css_vars } from 'gpuix-svelte';
    import { untrack } from 'svelte';
    import { SvelteMap } from 'svelte/reactivity';
    import type { RpcNotification, CommandRecord, CommandDraft, ImportRisk, RunRecord, SettingsRecord } from '@cmdmark/protocol';
    import type { RpcClient } from '@cmdmark/protocol/client';
    import { resolveTemplate, templateVariables } from '@cmdmark/protocol/template';
    import { connectGui, type GuiConnection } from './src/connection.ts';
    import { RunLogStream } from './src/logs.ts';
    import { launchTerminal } from './src/terminal.ts';
    import ActionButton from './components/ActionButton.svelte';
    import CommandEditor from './components/CommandEditor.svelte';
    import LibraryView from './components/LibraryView.svelte';
    import LogViewer from './components/LogViewer.svelte';
    import Modal from './components/Modal.svelte';
    import ParameterPrompt from './components/ParameterPrompt.svelte';
    import RunsView from './components/RunsView.svelte';
    import SettingsView from './components/SettingsView.svelte';

    type View = 'library' | 'runs' | 'settings' | 'logs';
    interface LogSession {
        stream: RunLogStream;
        initialized: boolean;
        queued: Array<{ offset: number; dataBase64: string }>;
        subscriptionId: string | null;
    }

    const PALETTE = {
        shell: '#202925',
        'shell-raised': '#29342e',
        'shell-hover': '#35423a',
        paper: '#f7f5ef',
        'paper-bright': '#fbfaf6',
        surface: '#efeee7',
        'surface-deep': '#e4e4da',
        'surface-hover': '#eeeee6',
        line: '#dfdfd5',
        'line-strong': '#c9cdc2',
        ink: '#202a25',
        'ink-soft': '#39463f',
        'ink-muted': '#707a72',
        'ink-faint': '#9aa197',
        accent: '#bd6446',
        'accent-hover': '#a95237',
        'accent-pressed': '#91422d',
        'accent-ink': '#fffaf4',
        selected: '#e5ebe1',
        focus: '#bb6748',
        success: '#4f9278',
        'success-ink': '#35725d',
        warning: '#c78b3e',
        danger: '#b4493d',
        'danger-wash': '#f5e7e2',
        'code-surface': '#e9e8df',
        'code-ink': '#29382f',
        'log-surface': '#1f2824',
        'log-ink': '#e8e9df',
        'log-muted': '#7d8c80',
        'scroller-thumb': '#abb2a6',
        'scroller-thumb-hover': '#7e897d'
    };

    let { client: initialClient, error: initialError }: GuiConnection = $props();
    const initialConnection = untrack(() => ({ client: initialClient, error: initialError }));
    let client = $state<RpcClient | null>(initialConnection.client);
    let connectionError = $state<string | null>(initialConnection.error);
    let view = $state<View>('library');
    let commands = $state<CommandRecord[]>([]);
    let visibleCommands = $state<CommandRecord[]>([]);
    let searchText = $state('');
    let selectedTag = $state<string | null>(null);
    let selectedCommandId = $state<string | null>(null);
    let runs = $state<RunRecord[]>([]);
    let settings = $state<SettingsRecord>({
        terminal: null,
        defaultShell: '/bin/sh',
        gracePeriodMs: 5000,
        bufferSizeBytes: 256 * 1024,
        attachDetachKey: 'ctrl-]'
    });
    let now = $state(Date.now());
    let loading = $state(true);
    let busy = $state(false);
    let errorMessage = $state('');
    let toast = $state('');
    let quickCommand = $state('');
    let editorOpen = $state(false);
    let editingCommand = $state<CommandRecord | null>(null);
    let editorInitialCommand = $state('');
    let deleteTarget = $state<CommandRecord | null>(null);
    let promptCommand = $state<CommandRecord | null>(null);
    let importPreview = $state<{ commands: CommandDraft[]; risks: ImportRisk[] } | null>(null);
    let logRun = $state<RunRecord | null>(null);
    let logLines = $state<string[]>([]);
    let logFollowing = $state(true);
    const logSessions = new SvelteMap<string, LogSession>();
    let searchRequest = 0;
    let toastTimer: ReturnType<typeof setTimeout> | null = null;

    const tags = $derived([...new Set(commands.flatMap((command) => command.tags))].sort((a, b) => a.localeCompare(b)));
    const activeRunCount = $derived(runs.filter((run) => run.endedAt === null).length);

    $effect(() => {
        set_css_vars(PALETTE);
    });

    $effect(() => {
        if (!client) return;
        let alive = true;
        const currentClient = client;
        const unsubscribeNotifications = currentClient.onNotification((notification) => {
            if (notification.method === 'commands.changed') {
				void refreshCommands(currentClient).catch(showError);
				void refreshSearch(currentClient, searchText, selectedTag).catch(showError);
            } else if (notification.method === 'settings.changed') {
                settings = notification.params.settings;
            } else if (notification.method === 'run.state') {
                upsertRun(notification.params.run);
            } else if (notification.method === 'run.output') {
                consumeLogOutput(notification);
            }
        });
        let subscriptionId: string | null = null;
        void (async () => {
            try {
                subscriptionId = (await currentClient.request('runs.subscribe', {})).subscriptionId;
                const [commandResult, runResult, settingsResult] = await Promise.all([
                    currentClient.request('commands.list', {}),
                    currentClient.request('runs.list', {}),
                    currentClient.request('settings.get', {})
                ]);
                if (!alive) return;
                commands = commandResult.commands;
                runs = runResult.runs;
                settings = settingsResult.settings;
                await refreshSearch(currentClient, searchText, selectedTag);
            } catch (caught) {
                if (alive) showError(caught);
            } finally {
                if (alive) loading = false;
            }
        })();
        const clock = setInterval(() => (now = Date.now()), 1000);
        const unsubscribeKeys = on_window_key('keydown', (event) => {
            if (event.defaultPrevented) return;
            if (event.key === 'escape') {
                if (promptCommand) promptCommand = null;
                else if (importPreview) importPreview = null;
                else if (editorOpen) editorOpen = false;
                else if (deleteTarget) deleteTarget = null;
                else if (view === 'logs') { void closeLogSession(); view = 'runs'; }
                return;
            }
            if (event.editing) return;
            if (event.modifiers?.ctrl && event.key === '1') navigate('library');
            if (event.modifiers?.ctrl && event.key === '2') navigate('runs');
            if (event.modifiers?.ctrl && event.key === '3') navigate('settings');
        });
        return () => {
            alive = false;
            clearInterval(clock);
            unsubscribeNotifications();
            unsubscribeKeys();
            if (subscriptionId) void currentClient.request('runs.unsubscribe', { subscriptionId }).catch(() => {});
        };
    });

    $effect(() => {
        const currentClient = client;
        const query = searchText;
        const tag = selectedTag;
        if (!currentClient) {
            visibleCommands = [];
            return;
        }
        let alive = true;
        const requestId = ++searchRequest;
        const timer = setTimeout(() => {
            void refreshSearch(currentClient, query, tag, requestId).catch(showError);
        }, 120);
        return () => {
            alive = false;
            clearTimeout(timer);
        };
    });

    async function refreshCommands(currentClient = client): Promise<void> {
        if (!currentClient) return;
        const result = await currentClient.request('commands.list', {});
        commands = result.commands;
        if (selectedCommandId && !commands.some((command) => command.id === selectedCommandId)) selectedCommandId = null;
    }

    async function refreshSearch(
        currentClient = client,
        query = searchText,
        tag = selectedTag,
        requestId = ++searchRequest
    ): Promise<void> {
        if (!currentClient) return;
        const result = await currentClient.request('commands.search', {
            query,
            ...(tag ? { tag } : {})
        });
        if (requestId !== searchRequest) return;
        visibleCommands = result.hits.map((hit) => hit.command);
    }

    function upsertRun(run: RunRecord): void {
        runs = [run, ...runs.filter((candidate) => candidate.runId !== run.runId)]
            .sort((left, right) => right.startedAt - left.startedAt);
        if (logRun?.runId === run.runId) logRun = run;
    }

    function consumeLogOutput(notification: Extract<RpcNotification, { method: 'run.output' }>): void;
    function consumeLogOutput(notification: RpcNotification): void;
    function consumeLogOutput(notification: RpcNotification): void {
        if (notification.method !== 'run.output') return;
        const session = logSessions.get(notification.params.runId);
        if (!session) return;
        if (!session.initialized) {
            session.queued.push({ offset: notification.params.offset, dataBase64: notification.params.dataBase64 });
            return;
        }
        logLines = session.stream.push(notification.params.offset, notification.params.dataBase64);
    }

    function showError(caught: unknown): void {
        errorMessage = caught instanceof Error ? caught.message : String(caught);
    }

    function showToast(message: string): void {
        toast = message;
        if (toastTimer) clearTimeout(toastTimer);
        toastTimer = setTimeout(() => (toast = ''), 2400);
    }

    function navigate(next: View): void {
        if (view === 'logs' && next !== 'logs') void closeLogSession();
        view = next;
    }

    function activateNavigation(event: { key?: string; preventDefault(): void }, next: View): void {
        if (event.key !== 'enter' && event.key !== ' ' && event.key !== 'space') return;
        event.preventDefault();
        navigate(next);
    }

    async function retryConnection(): Promise<void> {
        loading = true;
        const result = await connectGui();
        client = result.client;
        connectionError = result.error;
        loading = false;
    }

    function startEditing(command: CommandRecord | null, initialCommand = ''): void {
        editingCommand = command;
        editorInitialCommand = initialCommand;
        editorOpen = true;
    }

    async function saveCommand(draft: CommandDraft): Promise<void> {
        if (!client) throw new Error(connectionError ?? 'cmdmarkd is unavailable');
        if (editingCommand) {
            await client.request('commands.update', { id: editingCommand.id, patch: draft });
            showToast('Bookmark updated');
        } else {
            await client.request('commands.create', { command: draft });
            showToast('Bookmark saved');
        }
        editorOpen = false;
        editorInitialCommand = '';
        await refreshCommands();
        await refreshSearch();
    }

    async function toggleFavorite(command: CommandRecord): Promise<void> {
        if (!client) return;
        try {
            await client.request('commands.favorite', { id: command.id, favorite: !command.favorite });
        } catch (caught) {
            showError(caught);
        }
    }

    async function duplicateCommand(command: CommandRecord): Promise<void> {
        if (!client) return;
        try {
            await client.request('commands.duplicate', { id: command.id });
            showToast('Bookmark duplicated');
        } catch (caught) {
            showError(caught);
        }
    }

    async function confirmDelete(): Promise<void> {
        if (!client || !deleteTarget) return;
        try {
            await client.request('commands.delete', { id: deleteTarget.id });
            showToast('Bookmark deleted; run history kept');
            deleteTarget = null;
            await refreshCommands();
            await refreshSearch();
        } catch (caught) {
            showError(caught);
        }
    }

    function runBookmark(command: CommandRecord): void {
        const variables = templateVariables(command.command, command.params);
        if (variables.length > 0) {
            promptCommand = command;
            return;
        }
        void startBookmark(command, command.command).catch(showError);
    }

    async function startBookmark(command: CommandRecord, templateCommand: string, values: Record<string, string> = {}): Promise<void> {
        if (!client) throw new Error(connectionError ?? 'cmdmarkd is unavailable');
        const resolvedCommand = resolveTemplate(templateCommand, values, command.params);
        const { run } = await client.request('runs.start', {
            commandId: command.id,
            command: resolvedCommand,
            cwd: command.cwd,
            shell: command.shell,
            env: command.env
        });
        upsertRun(run);
        promptCommand = null;
        navigate('runs');
        showToast(`Started ${command.name}`);
    }

    async function runQuickCommand(): Promise<void> {
        if (!client || !quickCommand.trim()) return;
        busy = true;
        try {
            const { run } = await client.request('runs.start', { command: quickCommand.trim() });
            upsertRun(run);
            quickCommand = '';
            navigate('runs');
            showToast('Ad-hoc command started');
        } catch (caught) {
            showError(caught);
        } finally {
            busy = false;
        }
    }

    async function stopRun(run: RunRecord): Promise<void> {
        if (!client) return;
        try {
            upsertRun((await client.request('runs.stop', { runId: run.runId })).run);
        } catch (caught) {
            showError(caught);
        }
    }

    async function killRun(run: RunRecord): Promise<void> {
        if (!client) return;
        try {
            upsertRun((await client.request('runs.signal', { runId: run.runId, signal: 'SIGKILL' })).run);
        } catch (caught) {
            showError(caught);
        }
    }

    async function signalRun(run: RunRecord, signal: 'SIGSTOP' | 'SIGCONT'): Promise<void> {
        if (!client) return;
        try {
            upsertRun((await client.request('runs.signal', { runId: run.runId, signal })).run);
        } catch (caught) {
            showError(caught);
        }
    }

    async function restartRun(run: RunRecord): Promise<void> {
        if (!client) return;
        try {
            upsertRun((await client.request('runs.restart', { runId: run.runId })).run);
            showToast('Restarted as a new run');
        } catch (caught) {
            showError(caught);
        }
    }

    async function openLogs(run: RunRecord): Promise<void> {
        if (!client) return;
        if (view === 'logs') await closeLogSession();
        const session: LogSession = { stream: new RunLogStream(), initialized: false, queued: [], subscriptionId: null };
        logSessions.set(run.runId, session);
        logRun = run;
        logLines = [];
        logFollowing = true;
        view = 'logs';
        try {
            session.subscriptionId = (await client.request('runs.subscribe', { runId: run.runId, includeOutput: true })).subscriptionId;
            const logs = await client.request('runs.logs', { runId: run.runId });
            logLines = session.stream.loadSnapshot(logs.dataBase64, logs.nextOffset);
            session.initialized = true;
            session.queued.sort((left, right) => left.offset - right.offset);
            for (const output of session.queued) logLines = session.stream.push(output.offset, output.dataBase64);
            session.queued = [];
        } catch (caught) {
            if (session.subscriptionId && client) await client.request('runs.unsubscribe', { subscriptionId: session.subscriptionId }).catch(() => {});
            logSessions.delete(run.runId);
            showError(caught);
        }
    }

    async function closeLogSession(): Promise<void> {
        if (!logRun) return;
        const runId = logRun.runId;
        const session = logSessions.get(runId);
        if (session?.subscriptionId && client) await client.request('runs.unsubscribe', { subscriptionId: session.subscriptionId }).catch(() => {});
        session?.stream.finish();
        logSessions.delete(runId);
        logRun = null;
        logLines = [];
    }

    async function openTerminal(run: RunRecord): Promise<void> {
        try {
            await launchTerminal(run.runId, settings.terminal);
        } catch (caught) {
            showError(caught);
        }
    }

    async function saveSettings(patch: Partial<SettingsRecord>): Promise<void> {
        if (!client) throw new Error(connectionError ?? 'cmdmarkd is unavailable');
        settings = (await client.request('settings.update', { patch })).settings;
        showToast('Settings saved');
    }

    async function exportBookmarks(path: string): Promise<void> {
        if (!client) throw new Error(connectionError ?? 'cmdmarkd is unavailable');
        const { json } = await client.request('commands.export', {});
        await writeFile(path, json, { encoding: 'utf8', mode: 0o600 });
        await chmod(path, 0o600);
    }

    async function reviewImport(path: string): Promise<void> {
        if (!client) throw new Error(connectionError ?? 'cmdmarkd is unavailable');
        const json = await readFile(path, 'utf8');
        importPreview = await client.request('commands.importPreview', { json });
    }

    async function confirmImport(): Promise<void> {
        if (!client || !importPreview) return;
        try {
            const imported = await client.request('commands.import', { commands: importPreview.commands });
            showToast(`Imported ${imported.commands.length} bookmarks; none were run`);
            importPreview = null;
            await refreshCommands();
            await refreshSearch();
        } catch (caught) {
            showError(caught);
        }
    }
</script>

<div class="app-shell">
    <div class="sidebar" role="navigation" aria-label="Primary navigation">
        <div class="brand-lockup">
            <div class="brand-mark"><text>c</text></div>
            <div class="brand-copy">
                <text class="brand-name">cmdmark</text>
                <text class="brand-caption">COMMAND FIELDNOTES</text>
            </div>
        </div>

        <text class="nav-label">WORKSPACE</text>
        <div class={['nav-item', { active: view === 'library' || view === 'logs' }]} role="button" tabindex="0" onclick={() => navigate('library')} onkeydown={(event) => activateNavigation(event, 'library')}>
            <text class="nav-icon">▤</text><text class="nav-text">Library</text><text class="nav-count">{commands.length}</text>
        </div>
        <div class={['nav-item', { active: view === 'runs' }]} role="button" tabindex="0" testId="runs-navigation" onclick={() => navigate('runs')} onkeydown={(event) => activateNavigation(event, 'runs')}>
            <text class="nav-icon">◉</text><text class="nav-text">Runs</text><text class="nav-count">{activeRunCount}</text>
        </div>
        <div class={['nav-item', { active: view === 'settings' }]} role="button" tabindex="0" testId="settings-navigation" onclick={() => navigate('settings')} onkeydown={(event) => activateNavigation(event, 'settings')}>
            <text class="nav-icon">⚙</text><text class="nav-text">Settings</text>
        </div>

        <div class="sidebar-spacer"></div>
        <div class="daemon-status">
            <div class={['status-light', { connected: client !== null }]}></div>
            <div class="status-copy">
                <text class="status-title">{client ? 'Daemon connected' : 'Daemon unavailable'}</text>
                <text class="status-detail">{client ? 'Local session · same user' : 'Start cmdmarkd to continue'}</text>
            </div>
        </div>
        <text class="sidebar-version">CMDMARK · 0.1.0</text>
    </div>

    <div class="main-area" role="main">
        <div class="topbar">
            <div class="page-heading">
                <text class="page-kicker">{view === 'library' || view === 'logs' ? 'COMMAND LIBRARY' : view === 'runs' ? 'PROCESS DESK' : 'PREFERENCES'}</text>
                <text class="page-title">{view === 'library' ? 'Your command shelf' : view === 'runs' ? 'Running & recent' : view === 'settings' ? 'Settings' : 'Run output'}</text>
            </div>
            <div class="topbar-meta">
                {#if client}<text class="connected-label">LOCAL DAEMON</text>{/if}
                <ActionButton label="+ New bookmark" kind="outline" onclick={() => startEditing(null)} testId="new-command" />
            </div>
        </div>

        <div class="quick-run" role="group" aria-label="Quick run">
            <div class="quick-prefix"><text>$</text></div>
            <input
                class="quick-input"
                value={quickCommand}
                placeholder="Quick run — enter a shell command"
                testId="quick-run-input"
                onchange={(event) => (quickCommand = event.value)}
                onsubmit={() => void runQuickCommand()}
            />
            <ActionButton label={busy ? 'Starting…' : 'Run now'} kind="primary" disabled={busy || !quickCommand.trim()} onclick={() => void runQuickCommand()} testId="quick-run-button" />
            <ActionButton label="Save" kind="quiet" disabled={!quickCommand.trim()} onclick={() => startEditing(null, quickCommand)} />
        </div>

        {#if errorMessage}
            <div class="error-banner"><text>{errorMessage}</text><ActionButton label="Dismiss" compact onclick={() => (errorMessage = '')} /></div>
        {/if}
        {#if toast}<div class="toast"><text>{toast}</text></div>{/if}

        {#if connectionError && !client}
            <div class="connection-state">
                <text class="connection-eyebrow">LOCAL DAEMON</text>
                <text class="connection-title">cmdmarkd did not start.</text>
                <text class="connection-copy">{connectionError}</text>
                <ActionButton label="Retry connection" kind="primary" onclick={() => void retryConnection()} />
            </div>
        {:else if loading}
            <div class="loading-state"><div class="loading-rule"></div><text>Opening your command shelf…</text></div>
        {:else if view === 'library'}
            <LibraryView
                commands={visibleCommands}
                tags={tags}
                query={searchText}
                selectedTag={selectedTag}
                selectedId={selectedCommandId}
                onQuery={(value) => (searchText = value)}
                onTag={(tag) => (selectedTag = tag)}
                onSelect={(id) => (selectedCommandId = id)}
                onRun={runBookmark}
                onEdit={(command) => startEditing(command)}
                onDuplicate={duplicateCommand}
                onDelete={(command) => (deleteTarget = command)}
                onFavorite={toggleFavorite}
            />
        {:else if view === 'runs'}
            <RunsView
                runs={runs}
                {now}
                onStop={(run) => void stopRun(run)}
                onKill={(run) => void killRun(run)}
                onRestart={(run) => void restartRun(run)}
                onSignal={(run, signal) => void signalRun(run, signal)}
                onLogs={(run) => void openLogs(run)}
                onAttach={(run) => void openTerminal(run)}
            />
        {:else if view === 'settings'}
            <SettingsView {settings} onSave={saveSettings} onExport={exportBookmarks} onImport={reviewImport} />
        {:else if logRun}
            <LogViewer run={logRun} lines={logLines} following={logFollowing} onFollowChange={(following) => (logFollowing = following)} onClose={() => { void closeLogSession(); view = 'runs'; }} />
        {/if}
    </div>
</div>

{#if editorOpen}
    <CommandEditor command={editingCommand} initialCommand={editorInitialCommand} onSave={saveCommand} onClose={() => (editorOpen = false)} />
{/if}

{#if promptCommand}
    <ParameterPrompt command={promptCommand} onRun={(resolved) => startBookmark(promptCommand!, resolved)} onClose={() => (promptCommand = null)} />
{/if}

{#if deleteTarget}
    <Modal title="Delete bookmark?" eyebrow="KEEP RUN HISTORY" onClose={() => (deleteTarget = null)} width={460} height={280}>
        <text class="confirm-copy">“{deleteTarget.name}” will leave the library. Existing runs and their logs remain in history.</text>
        <div class="confirm-actions">
            <ActionButton label="Cancel" kind="outline" onclick={() => (deleteTarget = null)} />
            <ActionButton label="Delete bookmark" kind="danger" onclick={() => void confirmDelete()} />
        </div>
    </Modal>
{/if}

{#if importPreview}
    <Modal title={`Import ${importPreview.commands.length} bookmarks?`} eyebrow="REVIEW BEFORE ADDING" onClose={() => (importPreview = null)} width={620} height={560}>
        <text class="confirm-copy">Imported commands are saved to the library and are never run automatically.</text>
        {#if importPreview.risks.length > 0}
            <div class="risk-list">
                <text class="risk-heading">Review these risky patterns</text>
                {#each importPreview.risks as risk, index (`${risk.name}-${index}`)}
                    <div class="risk-row">
                        <text class="risk-name">{risk.name}</text>
                        <text class="risk-patterns">{risk.patterns.join(' · ')}</text>
                        <text class="risk-command">{risk.command}</text>
                    </div>
                {/each}
            </div>
        {:else}
            <text class="safe-import">No known risky patterns detected.</text>
        {/if}
        <div class="confirm-actions">
            <ActionButton label="Cancel" kind="outline" onclick={() => (importPreview = null)} />
            <ActionButton label="Import bookmarks" kind="primary" disabled={importPreview.commands.length === 0} onclick={() => void confirmImport()} testId="confirm-import" />
        </div>
    </Modal>
{/if}

<style>
    .app-shell { position: relative; display: flex; flex-direction: row; width: 100%; height: 100%; background-color: var(--surface); color: var(--ink); }
    .sidebar { display: flex; flex-direction: column; width: 226px; flex-shrink: 0; padding: 24px 14px 15px; background-color: var(--shell); color: #f3f1e8; }
    .brand-lockup { display: flex; flex-direction: row; align-items: center; gap: 11px; padding: 0 9px 31px; }
    .brand-mark { display: flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 5px; background-color: var(--accent); color: var(--accent-ink); font-family: monospace; font-size: 23px; font-weight: 700; }
    .brand-copy { display: flex; flex-direction: column; gap: 2px; }
    .brand-name { color: #fbfaf4; font-size: 18px; font-weight: 800; }
    .brand-caption { color: #9ba69b; font-size: 8px; font-weight: 800; }
    .nav-label { padding: 0 11px 9px; color: #8d9a8f; font-size: 9px; font-weight: 800; }
    .nav-item { display: flex; flex-direction: row; align-items: center; gap: 11px; min-height: 42px; padding: 0 11px; border-radius: 5px; color: #c2cbc1; cursor: pointer; }
    .nav-item:hover { background-color: var(--shell-hover); color: #fffdf4; }
    .nav-item:focus-visible { outline-width: 2px; outline-color: #e9a286; outline-offset: 1px; }
    .nav-item.active { background-color: var(--shell-raised); color: #fffdf4; }
    .nav-icon { width: 18px; color: #d39173; font-size: 15px; text-align: center; }
    .nav-text { flex-grow: 1; font-size: 13px; font-weight: 600; }
    .nav-count { color: #96a195; font-family: monospace; font-size: 10px; }
    .sidebar-spacer { flex-grow: 1; }
    .daemon-status { display: flex; flex-direction: row; align-items: center; gap: 10px; padding: 12px 10px; border-top-width: 1px; border-color: #3b463e; }
    .status-light { width: 8px; height: 8px; border-radius: 4px; background-color: #c77a5a; }
    .status-light.connected { background-color: #76ae8f; }
    .status-copy { display: flex; flex-direction: column; gap: 3px; }
    .status-title { color: #e3e8df; font-size: 11px; font-weight: 700; }
    .status-detail { color: #97a297; font-size: 9px; }
    .sidebar-version { padding: 4px 10px 0; color: #718075; font-size: 8px; font-weight: 700; }

    .main-area { display: flex; flex-direction: column; flex-grow: 1; min-width: 0; min-height: 0; gap: 18px; padding: 24px 30px 22px; }
    .topbar { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 20px; min-height: 54px; }
    .page-heading { display: flex; flex-direction: column; gap: 3px; }
    .page-kicker { color: var(--accent); font-size: 9px; font-weight: 800; }
    .page-title { color: var(--ink); font-size: 25px; font-weight: 800; }
    .topbar-meta { display: flex; flex-direction: row; align-items: center; gap: 13px; }
    .connected-label { color: var(--ink-faint); font-size: 9px; font-weight: 800; }
    .quick-run { display: flex; flex-direction: row; align-items: center; gap: 9px; min-height: 54px; padding: 7px 8px 7px 14px; border-radius: 7px; background-color: #2c3731; }
    .quick-prefix { display: flex; align-items: center; justify-content: center; width: 25px; height: 30px; border-radius: 4px; background-color: #3a473e; color: #df9978; font-family: monospace; font-size: 17px; font-weight: 800; }
    .quick-input { flex-grow: 1; min-width: 0; padding: 0 7px; background-color: transparent; color: #f3f1e8; font-family: monospace; font-size: 13px; }
    .quick-input:focus-visible { outline-width: 2px; outline-color: #e9a286; outline-offset: 2px; }
    .error-banner { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; padding: 8px 12px; border-radius: 5px; background-color: var(--danger-wash); color: var(--danger); font-size: 12px; }
    .toast { position: absolute; right: 30px; bottom: 24px; padding: 10px 15px; border-radius: 5px; background-color: var(--shell); color: #fbfaf4; font-size: 12px; pointer-events: none; }
    .connection-state { display: flex; flex-direction: column; align-items: flex-start; gap: 10px; flex-grow: 1; justify-content: center; padding: 30px; }
    .connection-eyebrow { color: var(--accent); font-size: 10px; font-weight: 800; }
    .connection-title { color: var(--ink); font-size: 25px; font-weight: 800; }
    .connection-copy { max-width: 550px; color: var(--ink-muted); font-size: 13px; }
    .loading-state { display: flex; flex-direction: column; justify-content: center; align-items: flex-start; flex-grow: 1; gap: 12px; color: var(--ink-muted); font-size: 13px; }
    .loading-rule { width: 80px; height: 3px; background-color: var(--accent); }
    .confirm-copy { color: var(--ink-soft); font-size: 14px; }
    .confirm-actions { display: flex; flex-direction: row; justify-content: end; gap: 8px; padding-top: 4px; }
    .risk-list { display: flex; flex-direction: column; gap: 8px; }
    .risk-heading { color: var(--danger); font-size: 12px; font-weight: 800; }
    .risk-row { display: flex; flex-direction: column; gap: 4px; padding: 10px; border-radius: 4px; background-color: var(--danger-wash); }
    .risk-name { color: var(--ink); font-size: 12px; font-weight: 700; }
    .risk-patterns { color: var(--danger); font-size: 11px; font-weight: 700; }
    .risk-command { color: var(--code-ink); font-family: monospace; font-size: 11px; white-space: normal; }
    .safe-import { color: var(--success-ink); font-size: 12px; font-weight: 700; }
</style>
