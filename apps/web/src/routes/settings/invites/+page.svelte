<script lang="ts">
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    let { data, form } = $props();
    let dismissed = $state(false);
    let copied = $state(false);
    // 防双发：双击会生成两个邀请码
    let creating = $state(false);
    function statusOf(inv: { revokedAt: number | null; expiresAt: number }): string {
        if (inv.revokedAt !== null) return '已撤销';
        if (inv.expiresAt <= Date.now()) return '已过期';
        return '有效';
    }
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
    <h1>邀请码管理</h1>

    {#if form?.plaintext && !dismissed}
    <div class="reveal">
        <p>新邀请码（仅此一次显示，请立即复制保存；离开或刷新后不可再见）：</p>
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
        <input name="note" placeholder="如 给同事的注册码" required>
        <select name="days" aria-label="有效期">
            <option value="1">1 天</option>
            <option value="7" selected>7 天</option>
            <option value="30">30 天</option>
        </select>
        <button disabled={creating}>生成新邀请码</button>
    </form>

    <table>
        <thead><tr><th>备注</th><th>创建者</th><th>有效期至</th><th>状态</th><th>已用次数</th><th>最近使用</th><th></th></tr></thead>
        <tbody>
            {#each data.invites as i (i.id)}
            <tr>
                <td>{i.note}</td>
                <td>{i.creatorEmail}</td>
                <td>{new Date(i.expiresAt).toLocaleString()}</td>
                <td class:ok={statusOf(i) === '有效'} class:muted={statusOf(i) !== '有效'}>{statusOf(i)}</td>
                <td>{i.usedCount}</td>
                <td>{i.lastUsedAt ? new Date(i.lastUsedAt).toLocaleString() : '—'}</td>
                <td>
                    {#if statusOf(i) === '有效'}
                    <form method="POST" action="?/revoke"
                        use:enhance={({ cancel }) => {
                            if (!confirm('撤销此邀请码？已拿到码的人将无法再注册。')) { cancel(); return; }
                            return async ({ result }) => { if (result.type === 'success') await invalidateAll(); };
                        }}>
                        <input type="hidden" name="id" value={i.id}>
                        <button>撤销</button>
                    </form>
                    {:else}—{/if}
                </td>
            </tr>
            {/each}
        </tbody>
    </table>
</div>

<style>
    /* 页面自身留边距（勿用 :global(body)——会连 topnav 一起缩进，且各页互相污染） */
    .settings-page { font-family: system-ui, sans-serif; padding: 1.5rem; }
    .reveal { background: var(--rr-warning-soft); border: 1px solid var(--rr-warning-border); padding: 1rem; border-radius: 6px; margin: 1rem 0; }
    .reveal code { display: block; word-break: break-all; padding: 0.5rem; background: var(--rr-card-bg); border-radius: 4px; margin: 0.5rem 0; }
    .reveal-actions { display: flex; gap: 0.5rem; align-items: center; }
    form { margin: 1rem 0; display: flex; gap: 0.5rem; align-items: center; }
    select { padding: 0.3rem 0.5rem; border: 1px solid var(--rr-input-border); border-radius: 5px; background: var(--rr-input-bg); color: var(--rr-text); }
    table { border-collapse: collapse; margin-top: 1rem; }
    th, td { border: 1px solid var(--rr-border); padding: 0.4rem 0.8rem; text-align: left; }
    td.ok { color: var(--rr-success); }
    td.muted { color: var(--rr-text-muted); }
</style>
