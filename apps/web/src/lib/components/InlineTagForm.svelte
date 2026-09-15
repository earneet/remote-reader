<script lang="ts">
    // 行内标签编辑表单（目录视图与 RecentList 共用，A-1 第一步抽取）
    import { autofocus } from '$lib/shared/autofocus';

    let {
        initialValue = '',
        busy = false,
        error = null,
        onSave,
        onCancel
    }: {
        initialValue?: string;
        busy?: boolean;
        error?: string | null;
        onSave: (tags: string) => void;
        onCancel: () => void;
    } = $props();

    let value = $state(initialValue);
</script>

<form class="inline-form" onsubmit={(e) => { e.preventDefault(); onSave(value); }}>
    <input value={value} placeholder="逗号分隔，如 周报, api" use:autofocus disabled={busy}
        oninput={(e) => (value = e.currentTarget.value)}
        onkeydown={(e) => { if (e.key === 'Escape') onCancel(); }}>
    <button type="submit" class="btn sm primary" disabled={busy}>保存</button>
    <button type="button" class="btn sm" onclick={onCancel}>取消</button>
    {#if error}<span class="form-error">{error}</span>{/if}
</form>

<style>
    .inline-form { display: inline-flex; align-items: center; gap: 0.3rem; }
    .inline-form input {
        padding: 0.25rem 0.5rem; border: 1px solid var(--rr-accent); border-radius: 5px;
        font-size: 0.8rem; min-width: 12rem; background: var(--rr-input-bg); color: var(--rr-text);
    }
    .form-error { color: var(--rr-danger); font-size: 0.8em; white-space: nowrap; }
</style>
