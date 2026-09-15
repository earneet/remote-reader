<script lang="ts">
    // 行内重命名表单（目录视图与 RecentList 共用，A-1 第一步抽取）：受控输入 + 保存/取消 + 失败提示。
    // 提交机制由父级决定（fetch/enhance 均可）——本组件只负责呈现与键盘交互
    import { autofocus } from '$lib/shared/autofocus';

    let {
        initialName,
        busy = false,
        error = null,
        onSave,
        onCancel
    }: {
        initialName: string;
        busy?: boolean;
        error?: string | null;
        onSave: (name: string) => void;
        onCancel: () => void;
    } = $props();

    let value = $state(initialName);
</script>

<form class="inline-form" onsubmit={(e) => { e.preventDefault(); if (value.trim()) onSave(value.trim()); }}>
    <input value={value} required use:autofocus disabled={busy}
        oninput={(e) => (value = e.currentTarget.value)}
        onkeydown={(e) => { if (e.key === 'Escape') onCancel(); }}>
    <button type="submit" class="btn sm primary" disabled={busy}>保存</button>
    <button type="button" class="btn sm" onclick={onCancel}>取消</button>
    {#if error}<span class="form-error">{error}</span>{/if}
</form>

<style>
    .inline-form { display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0; }
    .inline-form input {
        flex: 1; min-width: 0; padding: 0.3rem 0.5rem;
        border: 1px solid var(--rr-accent); border-radius: 5px; font-size: 0.95rem;
        background: var(--rr-input-bg); color: var(--rr-text);
    }
    .inline-form input:focus { outline: none; box-shadow: 0 0 0 2px var(--rr-focus-ring); }
    .form-error { color: var(--rr-danger); font-size: 0.8em; white-space: nowrap; }
</style>
