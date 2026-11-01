<script lang="ts">
    import { get_native, type GpuixEvent, type ShadowNode } from 'gpuix-svelte';
    import type { RunRecord } from '@cmdmark/protocol';
    import ActionButton from './ActionButton.svelte';

    interface Props {
        run: RunRecord;
        lines: string[];
        following: boolean;
        onFollowChange: (following: boolean) => void;
        onClose: () => void;
    }

    let { run, lines, following, onFollowChange, onClose }: Props = $props();
    let listNode: ShadowNode | null = null;

    function scrollToTail() {
        const native = get_native();
        if (!native || !listNode?.nativeId || lines.length === 0) return;
        native.scrollToItem(listNode.nativeId, lines.length - 1, 0);
    }

    function visibleRange(event: GpuixEvent) {
        const endIndex = event.endIndex ?? 0;
        const atTail = lines.length === 0 || endIndex >= lines.length - 1;
        if (atTail !== following) onFollowChange(atTail);
    }

    function toggleFollow() {
        const next = !following;
        onFollowChange(next);
    }

    $effect(() => {
        lines.length;
        if (following) scrollToTail();
    });
</script>

<div class="log-view">
    <div class="log-head">
        <div class="log-title-group">
            <text class="eyebrow">RUN LOG</text>
            <text class="log-title">{run.resolvedCommand}</text>
            <text class="log-meta">{run.runId.slice(0, 8)} · {run.state}{run.exitCode === null ? '' : ` · exit ${run.exitCode}`}</text>
        </div>
        <div class="log-tools">
            <ActionButton label={following ? 'Following tail' : 'Follow output'} kind={following ? 'outline' : 'quiet'} compact onclick={toggleFollow} testId="follow-toggle" />
            <ActionButton label="Close logs" compact onclick={onClose} />
        </div>
    </div>
    <div class="log-surface">
        <virtual-list
            {@attach (node: ShadowNode) => (listNode = node)}
            class="log-list"
            testId="log-list"
            estimatedItemHeight={24}
            alignment="bottom"
            onvisiblerange={visibleRange}
        >
            {#each lines as line, index (`${index}-${line}`)}
                <div class="log-row" style="width: 100%" testId={`log-line-${index}`}>
                    <text class="line-number">{String(index + 1).padStart(4, '0')}</text>
                    <text class="log-line">{line || ' '}</text>
                </div>
            {/each}
        </virtual-list>
    </div>
</div>

<style>
    .log-view { display: flex; flex-direction: column; flex-grow: 1; min-height: 0; gap: 14px; }
    .log-head { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 16px; }
    .log-title-group { display: flex; flex-direction: column; gap: 4px; min-width: 0; }
    .eyebrow { color: var(--accent); font-size: 10px; font-weight: 800; }
    .log-title { color: var(--ink); font-family: monospace; font-size: 14px; white-space: nowrap; text-overflow: ellipsis; }
    .log-meta { color: var(--ink-muted); font-size: 11px; }
    .log-tools { display: flex; flex-direction: row; align-items: center; gap: 6px; flex-shrink: 0; }
    .log-surface { display: flex; flex-direction: column; flex-grow: 1; min-height: 0; width: 100%; border-radius: 6px; background-color: var(--log-surface); color: var(--log-ink); }
    .log-list { display: flex; flex-direction: column; flex-grow: 1; min-height: 0; width: 100%; padding: 8px; overflow-y: scroll; scrollbar-color: var(--scroller-thumb); scrollbar-width: 7px; }
    .log-row { display: flex; flex-direction: row; align-items: start; gap: 12px; width: 100%; min-height: 24px; padding: 3px 4px; color: var(--log-ink); }
    .line-number { width: 38px; flex-shrink: 0; color: var(--log-muted); font-family: monospace; font-size: 11px; text-align: right; }
    .log-line { flex-grow: 1; color: var(--log-ink); font-family: monospace; font-size: 12px; white-space: normal; }
</style>
