<script lang="ts">
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    let { data, form } = $props();
    let dismissed = $state(false);
    let copied = $state(false);
    // 防双发：create 无幂等约束，双击会生成两个 token
    let creating = $state(false);
    let actionError = $state<string | null>(null);
    async function copyPlaintext(text: string) {
        try {
            await navigator.clipboard.writeText(text);
            copied = true;
        } catch (e) {
            console.warn('clipboard write failed', e);
        }
    }
</script>

<div class="settings-page">
    <h1>API Token 管理</h1>
    {#if actionError}<p class="form-error" role="alert">{actionError}</p>{/if}

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

    <!-- 必须 await update()：enhance 自定义回调不调它，applyAction 就不执行 → form prop 不更新，
         一次性明文 reveal（form?.plaintext）永不显示。invalidateAll 只刷新 data，不写 form。 -->
    <form method="POST" action="?/create" use:enhance={() => {
        creating = true;
        return async ({ result, update }) => {
            creating = false;
            if (result.type === 'success') { dismissed = false; copied = false; await update(); }
        };
    }}>
        <input name="name" placeholder="如 claude-code-laptop" required>
        <button disabled={creating}>生成新 token</button>
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
                            return async ({ result }) => {
                                if (result.type === 'success') { actionError = null; await invalidateAll(); }
                                else if (result.type === 'failure') {
                                    actionError = String((result.data as { error?: string } | undefined)?.error ?? '撤销失败，请重试');
                                }
                            };
                        }}>
                        <input type="hidden" name="id" value={t.id}>
                        <button>撤销</button>
                    </form>
                </td>
            </tr>
            {/each}
        </tbody>
    </table>
</div>

<style>
    /* 页面自身留边距（勿用 :global(body)——会连 topnav 一起缩进，且各页互相污染） */
    .settings-page { font-family: system-ui, sans-serif; padding: 1.5rem; }
    .form-error { color: var(--rr-danger); font-size: 0.9rem; }
    .reveal { background: var(--rr-warning-soft); border: 1px solid var(--rr-warning-border); padding: 1rem; border-radius: 6px; margin: 1rem 0; }
    .reveal code { display: block; word-break: break-all; padding: 0.5rem; background: var(--rr-card-bg); border-radius: 4px; margin: 0.5rem 0; }
    .reveal-actions { display: flex; gap: 0.5rem; align-items: center; }
    form { margin: 1rem 0; }
    table { border-collapse: collapse; margin-top: 1rem; }
    th, td { border: 1px solid var(--rr-border); padding: 0.4rem 0.8rem; text-align: left; }
</style>
