<script lang="ts">
    import type { RunRecord } from '@cmdmark/protocol';
    import Scroller from 'gpuix-svelte/components/Scroller.svelte';
    import ActionButton from './ActionButton.svelte';

    interface Props {
        runs: RunRecord[];
        now: number;
        onStop: (run: RunRecord) => void;
        onKill: (run: RunRecord) => void;
        onRestart: (run: RunRecord) => void;
        onSignal: (run: RunRecord, signal: 'SIGSTOP' | 'SIGCONT') => void;
        onLogs: (run: RunRecord) => void;
        onAttach: (run: RunRecord) => void;
        onDelete: (run: RunRecord) => void;
        onClearHistory: () => void;
    }

    let { runs, now, onStop, onKill, onRestart, onSignal, onLogs, onAttach, onDelete, onClearHistory }: Props = $props();
    const completedCount = $derived(runs.filter((run) => run.endedAt !== null).length);

    function stateLabel(run: RunRecord): string {
        if (run.state === 'stopped' && run.endedAt === null) return 'paused';
        return run.state;
    }

    function elapsed(run: RunRecord): string {
        const end = run.endedAt ?? now;
        const seconds = Math.max(0, Math.floor((end - run.startedAt) / 1000));
        if (seconds >= 3600) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
        if (seconds >= 60) return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
        return `${seconds}s`;
    }
</script>

{#if runs.length === 0}
    <div class="empty-state">
        <text class="eyebrow">PROCESS DESK</text>
        <text class="empty-title">No runs yet.</text>
        <text class="empty-copy">Start a bookmark or use the quick-run bar to see its live state here.</text>
    </div>
{:else}
    <div class="runs-view">
        <div class="runs-toolbar">
            <div class="runs-summary">
                <text class="eyebrow">RUN HISTORY</text>
                <text class="runs-count">{runs.length} {runs.length === 1 ? 'run' : 'runs'} · {completedCount} completed</text>
            </div>
            {#if completedCount > 0}
                <ActionButton label={`Clear history (${completedCount})`} kind="danger" compact onclick={onClearHistory} testId="clear-run-history" />
            {/if}
        </div>
        <Scroller virtual estimate={92} pad="2px 10px 8px 0" testid="runs-scroll">
            {#each runs as run (run.runId)}
                {@const active = run.endedAt === null}
                {@const paused = run.state === 'stopped' && active}
                <div class="run-wrap" style="width: 100%">
                    <div class="run-row" testId={`run-row-${run.runId}`}>
                        <div class="state-col">
                            <div class={['state-dot', { live: active && !paused, paused }]}></div>
                            <text class={['state-text', { 'live-text': active && !paused }]}>{stateLabel(run)}</text>
                        </div>
                        <div class="run-copy">
                            <div class="run-meta">
                                <text class="run-id">{run.runId.slice(0, 8)}</text>
                                <text class="uptime">{elapsed(run)}</text>
                                {#if run.exitCode !== null}<text class={['exit-code', { 'bad-exit': run.exitCode !== 0 }]}>exit {run.exitCode}</text>{/if}
                                {#if run.signal}<text class="exit-code">{run.signal}</text>{/if}
                            </div>
                            <text class="run-command">{run.resolvedCommand}</text>
                            <text class="run-cwd">{run.cwd ?? 'current directory'} · pid {run.pid ?? '—'}</text>
                        </div>
                        <div class="run-actions">
                            {#if active}
                                <ActionButton label="Terminal" kind="outline" compact onclick={() => onAttach(run)} />
                            {/if}
                            <ActionButton label="Logs" compact onclick={() => onLogs(run)} />
                            {#if active}
                                {#if paused}
                                    <ActionButton label="Resume" kind="outline" compact onclick={() => onSignal(run, 'SIGCONT')} />
                                {:else}
                                    <ActionButton label="Pause" kind="outline" compact onclick={() => onSignal(run, 'SIGSTOP')} />
                                {/if}
                                <ActionButton label="Stop" kind="outline" compact onclick={() => onStop(run)} />
                                <ActionButton label="Kill" kind="danger" compact onclick={() => onKill(run)} />
                            {:else}
                                <ActionButton label="Restart" kind="primary" compact onclick={() => onRestart(run)} />
                                <ActionButton label="Delete" kind="danger" compact onclick={() => onDelete(run)} testId={`delete-run-${run.runId}`} />
                            {/if}
                        </div>
                    </div>
                </div>
            {/each}
        </Scroller>
    </div>
{/if}

<style>
    .runs-view { display: flex; flex-direction: column; flex-grow: 1; min-height: 0; gap: 10px; }
    .runs-toolbar { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 12px; min-height: 38px; }
    .runs-summary { display: flex; flex-direction: row; align-items: baseline; gap: 12px; }
    .runs-count { color: var(--ink-muted); font-size: 12px; }
    .run-wrap { width: 100%; padding: 4px 0; }
    .run-row { display: flex; flex-direction: row; align-items: center; gap: 16px; width: 100%; min-height: 82px; padding: 13px 14px; border-radius: 6px; background-color: var(--paper); }
    .state-col { display: flex; flex-direction: row; align-items: center; gap: 7px; width: 78px; flex-shrink: 0; }
    .state-dot { width: 8px; height: 8px; border-radius: 4px; background-color: var(--ink-faint); }
    .state-dot.live { background-color: var(--success); }
    .state-dot.paused { background-color: var(--warning); }
    .state-text { color: var(--ink-muted); font-size: 11px; }
    .state-text.live-text { color: var(--success-ink); font-weight: 700; }
    .run-copy { display: flex; flex-direction: column; gap: 5px; min-width: 0; flex-grow: 1; }
    .run-meta { display: flex; flex-direction: row; align-items: center; gap: 10px; }
    .run-id { color: var(--ink-faint); font-family: monospace; font-size: 10px; }
    .uptime { color: var(--ink-muted); font-size: 11px; font-family: monospace; }
    .exit-code { color: var(--ink-muted); font-size: 10px; }
    .exit-code.bad-exit { color: var(--danger); font-weight: 700; }
    .run-command { color: var(--code-ink); font-family: monospace; font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
    .run-cwd { color: var(--ink-faint); font-size: 10px; }
    .run-actions { display: flex; flex-direction: row; align-items: center; justify-content: flex-end; flex-wrap: wrap; gap: 3px; row-gap: 6px; flex-grow: 0; flex-shrink: 1; min-width: 0; }
    .empty-state { display: flex; flex-direction: column; align-items: flex-start; justify-content: center; gap: 9px; flex-grow: 1; padding: 28px; }
    .eyebrow { color: var(--accent); font-size: 10px; font-weight: 800; }
    .empty-title { color: var(--ink); font-size: 22px; font-weight: 700; }
    .empty-copy { color: var(--ink-muted); font-size: 14px; }
</style>
