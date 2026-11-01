<script lang="ts">
    import type { GpuixEvent } from 'gpuix-svelte';

    interface Props {
        label: string;
        onclick: () => void;
        kind?: 'primary' | 'quiet' | 'outline' | 'danger';
        disabled?: boolean;
        compact?: boolean;
        testId?: string;
        ariaLabel?: string;
    }

    let {
        label,
        onclick,
        kind = 'quiet',
        disabled = false,
        compact = false,
        testId,
        ariaLabel
    }: Props = $props();

    function activate(event: GpuixEvent) {
        if (disabled || (event.key !== 'enter' && event.key !== ' ' && event.key !== 'space')) return;
        event.preventDefault();
        event.stopPropagation();
        onclick();
    }
</script>

<div
    class={['action', {
        primary: kind === 'primary',
        outline: kind === 'outline',
        danger: kind === 'danger',
        compact,
        disabled
    }]}
    role="button"
    aria-label={ariaLabel ?? label}
    tabindex={disabled ? -1 : 0}
    testId={testId}
    onclick={() => !disabled && onclick()}
    onkeydown={activate}
>
    <text>{label}</text>
</div>

<style>
    .action {
        display: flex;
        align-items: center;
        justify-content: center;
        min-width: 36px;
        min-height: 36px;
        padding: 0 12px;
        border-radius: 5px;
        background-color: transparent;
        color: var(--ink-soft);
        font-size: 13px;
        font-weight: 600;
        cursor: pointer;
        user-select: none;
    }
    .action:hover { background-color: var(--surface-hover); color: var(--ink); }
    .action:active { background-color: var(--line); }
    .action:focus-visible { outline-width: 2px; outline-color: var(--focus); outline-offset: 2px; }
    .action.primary { background-color: var(--accent); color: var(--accent-ink); }
    .action.primary:hover { background-color: var(--accent-hover); }
    .action.primary:active { background-color: var(--accent-pressed); }
    .action.outline { border-width: 1px; border-color: var(--line-strong); border-style: solid; }
    .action.danger { color: var(--danger); }
    .action.danger:hover { background-color: var(--danger-wash); }
    .action.compact { min-width: 28px; min-height: 28px; padding: 0 8px; font-size: 12px; }
    .action.disabled { opacity: 0.45; cursor: not-allowed; pointer-events: none; }
</style>
