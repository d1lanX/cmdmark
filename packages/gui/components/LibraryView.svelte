<script lang="ts">
    import type { GpuixEvent, ShadowNode } from 'gpuix-svelte';
    import { focus_element } from 'gpuix-svelte';
    import { SvelteMap } from 'svelte/reactivity';
    import Scroller from 'gpuix-svelte/components/Scroller.svelte';
    import type { CommandRecord } from '@cmdmark/protocol';
    import ActionButton from './ActionButton.svelte';
    import Field from './TextField.svelte';

    interface Props {
        commands: CommandRecord[];
        tags: string[];
        query: string;
        selectedTag: string | null;
        selectedId: string | null;
        onQuery: (value: string) => void;
        onTag: (tag: string | null) => void;
        onSelect: (id: string) => void;
        onRun: (command: CommandRecord) => void;
        onEdit: (command: CommandRecord) => void;
        onDuplicate: (command: CommandRecord) => void;
        onDelete: (command: CommandRecord) => void;
        onFavorite: (command: CommandRecord) => void;
    }

    let {
        commands,
        tags,
        query,
        selectedTag,
        selectedId,
        onQuery,
        onTag,
        onSelect,
        onRun,
        onEdit,
        onDuplicate,
        onDelete,
        onFavorite
    }: Props = $props();
    const rowNodes = new SvelteMap<string, ShadowNode>();
    const cursor = $derived(Math.max(0, commands.findIndex((command) => command.id === selectedId)));

    function attachRow(id: string) {
        return (node: ShadowNode) => {
            rowNodes.set(id, node);
            return () => rowNodes.delete(id);
        };
    }

    function handleRowKey(event: GpuixEvent, command: CommandRecord) {
        const currentIndex = commands.findIndex((candidate) => candidate.id === command.id);
        if (event.key === 'enter' || event.key === ' ' || event.key === 'space') {
            event.preventDefault();
            onRun(command);
            return;
        }
        if (event.key !== 'arrowdown' && event.key !== 'arrowup') return;
        event.preventDefault();
        const delta = event.key === 'arrowdown' ? 1 : -1;
        const nextIndex = Math.max(0, Math.min(commands.length - 1, currentIndex + delta));
        const next = commands[nextIndex];
        if (next) {
            onSelect(next.id);
            const node = rowNodes.get(next.id);
            if (node) focus_element(node);
        }
    }

    function handleTagKey(event: GpuixEvent, tag: string | null) {
        if (event.key !== 'enter' && event.key !== ' ' && event.key !== 'space') return;
        event.preventDefault();
        onTag(tag);
    }
</script>

<div class="library">
    <div class="toolbar">
        <div class="search-wrap">
            <text class="search-mark">⌕</text>
            <input
                class="search"
                value={query}
                placeholder="Search commands, notes, tags…"
                testId="command-search"
                onchange={(event) => onQuery(event.value)}
            />
            <text class="shortcut">/</text>
        </div>
        <text class="count">{commands.length} {commands.length === 1 ? 'command' : 'commands'}</text>
    </div>

    <div class="tag-row">
        <text class="tag-caption">FILTER</text>
        <div class={['tag-chip', { active: selectedTag === null }]} tabindex="0" role="button" onclick={() => onTag(null)} onkeydown={(event) => handleTagKey(event, null)}>
            <text>All</text>
        </div>
        {#each tags as tag (tag)}
            <div class={['tag-chip', { active: selectedTag === tag }]} tabindex="0" role="button" onclick={() => onTag(tag)} onkeydown={(event) => handleTagKey(event, tag)}>
                <text>{tag}</text>
            </div>
        {/each}
    </div>

    {#if commands.length === 0}
        <div class="empty-state">
            <text class="empty-kicker">NO MATCHES</text>
            <text class="empty-title">Nothing in the library yet.</text>
            <text class="empty-copy">Save a repeatable command, or start with the quick-run strip above.</text>
        </div>
    {:else}
        <Scroller virtual estimate={96} pad="2px 10px 8px 0" testid="commands-scroll">
            {#each commands as command (command.id)}
                <div class="row-wrap" style="width: 100%">
                    <div
                        {@attach attachRow(command.id)}
                        class={['command-row', { selected: selectedId === command.id }]}
                        testId={`command-${command.id}`}
                        role="option"
                        aria-selected={selectedId === command.id}
                        tabindex={selectedId === command.id || (!selectedId && command === commands[0]) ? 0 : -1}
                        hitbox="self"
                        onclick={() => onSelect(command.id)}
                        onkeydown={(event) => handleRowKey(event, command)}
                    >
                        <div class="row-copy">
                            <div class="name-line">
                                <text class="command-name">{command.name}</text>
                                {#if command.favorite}<text class="favorite-marker">★</text>{/if}
                                {#if command.useCount > 0}<text class="use-count">used {command.useCount}×</text>{/if}
                            </div>
                            {#if command.description}<text class="description">{command.description}</text>{/if}
                            <text class="command-code">{command.command}</text>
                            {#if command.tags.length > 0}
                                <div class="row-tags">
                                    {#each command.tags.slice(0, 4) as tag (tag)}<text class="row-tag">{tag}</text>{/each}
                                </div>
                            {/if}
                        </div>
                        <div class="row-actions">
                            <ActionButton label="Run" kind="primary" compact onclick={() => onRun(command)} testId={`run-${command.id}`} />
                            <ActionButton label={command.favorite ? '★' : '☆'} ariaLabel={command.favorite ? 'Remove favorite' : 'Add favorite'} compact onclick={() => onFavorite(command)} />
                            <ActionButton label="Edit" compact onclick={() => onEdit(command)} />
                            <ActionButton label="Copy" compact onclick={() => onDuplicate(command)} />
                            <ActionButton label="Delete" kind="danger" compact onclick={() => onDelete(command)} />
                        </div>
                    </div>
                </div>
            {/each}
        </Scroller>
    {/if}
</div>

<style>
    .library { display: flex; flex-direction: column; flex-grow: 1; min-height: 0; gap: 10px; }
    .toolbar { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 18px; }
    .search-wrap { display: flex; flex-direction: row; align-items: center; gap: 9px; flex-grow: 1; max-width: 660px; min-height: 42px; padding: 0 12px; border-width: 1px; border-color: var(--line); border-style: solid; border-radius: 6px; background-color: var(--paper); }
    .search-mark { color: var(--accent); font-size: 22px; font-weight: 700; }
    .search { flex-grow: 1; min-width: 0; background-color: transparent; color: var(--ink); font-size: 14px; }
    .search:focus-visible { outline-width: 2px; outline-color: var(--focus); outline-offset: 1px; }
    .shortcut { padding: 2px 7px; border-radius: 3px; background-color: var(--surface-deep); color: var(--ink-muted); font-size: 11px; }
    .count { color: var(--ink-muted); font-size: 12px; }
    .tag-row { display: flex; flex-direction: row; align-items: center; gap: 7px; min-height: 34px; }
    .tag-caption { margin-right: 5px; color: var(--ink-faint); font-size: 10px; font-weight: 800; }
    .tag-chip { padding: 5px 10px; border-radius: 4px; background-color: transparent; color: var(--ink-muted); font-size: 12px; cursor: pointer; }
    .tag-chip:hover { background-color: var(--surface-hover); color: var(--ink); }
    .tag-chip:focus-visible { outline-width: 2px; outline-color: var(--focus); outline-offset: 1px; }
    .tag-chip.active { background-color: var(--surface-deep); color: var(--ink); font-weight: 700; }
    .row-wrap { width: 100%; padding: 4px 0; }
    .command-row { display: flex; flex-direction: row; align-items: center; justify-content: space-between; gap: 16px; width: 100%; min-height: 82px; padding: 14px 14px 14px 17px; border-radius: 6px; background-color: var(--paper); cursor: default; }
    .command-row:hover { background-color: var(--surface-hover); }
    .command-row.selected { background-color: var(--selected); }
    .command-row:focus-visible { outline-width: 2px; outline-color: var(--focus); outline-offset: 1px; }
    .row-copy { display: flex; flex-direction: column; gap: 5px; min-width: 0; flex-grow: 1; }
    .name-line { display: flex; flex-direction: row; align-items: center; gap: 8px; }
    .command-name { color: var(--ink); font-size: 15px; font-weight: 700; }
    .favorite-marker { color: var(--accent); font-size: 13px; }
    .use-count { color: var(--ink-faint); font-size: 10px; }
    .description { color: var(--ink-muted); font-size: 12px; }
    .command-code { color: var(--code-ink); font-family: monospace; font-size: 12px; white-space: nowrap; text-overflow: ellipsis; }
    .row-tags { display: flex; flex-direction: row; flex-wrap: wrap; gap: 5px; }
    .row-tag { padding: 2px 6px; border-radius: 3px; background-color: var(--surface-deep); color: var(--ink-muted); font-size: 10px; }
    .row-actions { display: flex; flex-direction: row; align-items: center; gap: 3px; flex-shrink: 0; }
    .empty-state { display: flex; flex-direction: column; align-items: flex-start; gap: 8px; flex-grow: 1; justify-content: center; padding: 26px; }
    .empty-kicker { color: var(--accent); font-size: 10px; font-weight: 800; }
    .empty-title { color: var(--ink); font-size: 22px; font-weight: 700; }
    .empty-copy { color: var(--ink-muted); font-size: 14px; }
</style>
