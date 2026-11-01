<script lang="ts">
    interface Props {
        label: string;
        value: string;
        onchange: (value: string) => void;
        placeholder?: string;
        multiline?: boolean;
        testId?: string;
        hint?: string;
        rows?: number;
    }

    let {
        label,
        value,
        onchange,
        placeholder = '',
        multiline = false,
        testId,
        hint = '',
        rows = 3
    }: Props = $props();
</script>

<div class="field">
    <text class="label">{label}</text>
    {#if multiline}
        <textarea
            class="control multiline"
            value={value}
            placeholder={placeholder}
            style="min-height: {rows * 24}px"
            testId={testId}
            onchange={(event) => onchange(event.value)}
        ></textarea>
    {:else}
        <input
            class="control"
            value={value}
            placeholder={placeholder}
            testId={testId}
            onchange={(event) => onchange(event.value)}
        />
    {/if}
    {#if hint}<text class="hint">{hint}</text>{/if}
</div>

<style>
    .field { display: flex; flex-direction: column; gap: 6px; width: 100%; }
    .label { color: var(--ink-soft); font-size: 12px; font-weight: 700; }
    .control {
        width: 100%;
        min-height: 38px;
        padding: 8px 10px;
        border-width: 1px;
        border-color: var(--line-strong);
        border-style: solid;
        border-radius: 5px;
        background-color: var(--paper);
        color: var(--ink);
        font-size: 14px;
        outline-width: 0;
    }
    .control:focus-visible { border-color: var(--accent); outline-width: 2px; outline-color: var(--focus); outline-offset: 1px; }
    .multiline { min-height: 78px; white-space: normal; }
    .hint { color: var(--ink-muted); font-size: 11px; }
</style>
