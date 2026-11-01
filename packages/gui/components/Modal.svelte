<script lang="ts">
    import type { Snippet } from 'svelte';
    import { focus_next_within, focus_previous_within, window_size, type GpuixEvent, type ShadowNode } from 'gpuix-svelte';
    import Portal from 'gpuix-svelte/components/Portal.svelte';
    import Scroller from 'gpuix-svelte/components/Scroller.svelte';
    import ActionButton from './ActionButton.svelte';

    interface Props {
        title: string;
        children: Snippet;
        onClose: () => void;
        width?: number;
        height?: number;
        eyebrow?: string;
    }

    let { title, children, onClose, width = 560, height = 520, eyebrow = 'CMDMARK' }: Props = $props();
    let dialogStyle = $derived(`width: ${Math.max(320, Math.min(width, window_size.width - 40))}px; height: ${Math.max(240, Math.min(height, window_size.height - 40))}px`);
    let dialogNode = $state<ShadowNode | null>(null);

    $effect(() => {
        if (dialogNode) focus_next_within(dialogNode);
    });

    function handleDialogKey(event: GpuixEvent) {
        if (event.key !== 'tab' || !dialogNode) return;
        event.preventDefault();
        if (event.modifiers?.shift) focus_previous_within(dialogNode);
        else focus_next_within(dialogNode);
    }
</script>

<Portal>
    <div class="scrim">
        <div {@attach (node: ShadowNode) => (dialogNode = node)} class="dialog" style={dialogStyle} role="dialog" aria-label={title} tabindex="-1" hitbox="self" onclick={() => {}} onkeydown={handleDialogKey}>
            <div class="dialog-head">
                <div class="heading-group">
                    <text class="eyebrow">{eyebrow}</text>
                    <text class="title">{title}</text>
                </div>
                <ActionButton label="×" ariaLabel="Close dialog" compact onclick={onClose} />
            </div>
            <div class="dialog-body">
                <Scroller gap={16} pad="20px 22px 22px">
                    {@render children()}
                </Scroller>
            </div>
        </div>
    </div>
</Portal>

<style>
    .scrim {
        position: absolute;
        inset: 0;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 20px;
        background-color: #15201dcc;
    }
    .dialog {
        display: flex;
        flex-direction: column;
        max-width: 92%;
        min-height: 0;
        border-radius: 8px;
        background-color: var(--paper);
        color: var(--ink);
        overflow: hidden;
    }
    .dialog-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 20px 22px 16px;
        border-bottom-width: 1px;
        border-color: var(--line);
    }
    .heading-group { display: flex; flex-direction: column; gap: 4px; }
    .eyebrow { color: var(--accent); font-size: 10px; font-weight: 800; }
    .title { color: var(--ink); font-size: 21px; font-weight: 700; }
    .dialog-body { display: flex; flex-direction: column; flex-grow: 1; flex-basis: 0; min-height: 0; width: 100%; }
</style>
