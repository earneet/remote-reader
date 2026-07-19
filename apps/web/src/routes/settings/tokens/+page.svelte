<script lang="ts">
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    let { data, form } = $props();
    let dismissed = $state(false);
    let copied = $state(false);
    async function copyPlaintext(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            copied = true;
        } catch (e) {
            console.warn('clipboard write failed', e);
        }
    }
</script>

<h1>API Token 管理</h1>

{#if form?.plaintext && !dismissed}
<div class="reveal">
    <p>新 token（仅此一次显示，请立即复制保存；离开或刷新后不可再见）：</p>
    <code>{form.plaintext}</code>
    <div class="reveal-actions">
        <button onclick={() => copyPlaintext(form!.plaintext!)}>{copied ? '已复制 ✓' : '复制'}</button>
        <button onclick={() => (dismissed = true)}>关闭</button>
    </div>
</div>
{/if}

<form method="POST" action="?/create" use:enhance={() => async ({ result }) => {
    if (result.type === 'success') { dismissed = false; copied = false; await invalidateAll(); }
}}>
    <input name="name" placeholder="如 claude-code-laptop" required>
    <button>生成新 token</button>
</form>

<table>
    <thead><tr><th>名称</th><th>创建时间</th><th>最近使用</th><th></th></tr></thead>
    <tbody>
        {#each data.tokens as t (t.id)}
        <tr>
            <td>{t.name}</td>
            <td>{new Date(t.createdAt).toLocaleString()}</td>
            <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : '—'}</td>
            <td>
                <form method="POST" action="?/revoke"
                    use:enhance={({ cancel }) => {
                        if (!confirm('撤销此 token？相关 Agent 将无法再认证。')) { cancel(); return; }
                        return async ({ result }) => { if (result.type === 'success') await invalidateAll(); };
                    }}>
                    <input type="hidden" name="id" value={t.id}>
                    <button>撤销</button>
                </form>
            </td>
        </tr>
        {/each}
    </tbody>
</table>

<style>
    :global(body) { font-family: system-ui, sans-serif; padding: 1.5rem; }
    .reveal { background: #fff8c5; border: 1px solid #d4a72c; padding: 1rem; border-radius: 6px; margin: 1rem 0; }
    .reveal code { display: block; word-break: break-all; padding: 0.5rem; background: #fff; border-radius: 4px; margin: 0.5rem 0; }
    .reveal-actions { display: flex; gap: 0.5rem; align-items: center; }
    form { margin: 1rem 0; }
    table { border-collapse: collapse; margin-top: 1rem; }
    th, td { border: 1px solid #d0d7de; padding: 0.4rem 0.8rem; text-align: left; }
</style>
