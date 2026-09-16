<script lang="ts">
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    let { data } = $props();
    let actionError = $state<string | null>(null);
    function abbr(token: string) {
        return token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : token;
    }
</script>

<div class="settings-page">
    <h1>分享链接</h1>
    {#if actionError}<p class="form-error" role="alert">{actionError}</p>{/if}

    {#if data.shares.length === 0}
    <p class="muted">暂无分享链接。Agent 上传文档或你在文件管理器点「复制分享链接」时会自动生成。</p>
    {:else}
    <table>
        <thead><tr><th>文档</th><th>token</th><th>创建时间</th><th></th></tr></thead>
        <tbody>
            {#each data.shares as s (s.token)}
            <tr>
                <td>{s.documentName}</td>
                <td><code>{abbr(s.token)}</code></td>
                <td>{new Date(s.createdAt).toLocaleString()}</td>
                <td>
                    <form method="POST" action="?/revoke"
                        use:enhance={({ cancel }) => {
                            if (!confirm('撤销此分享链接？链接将立即失效。')) { cancel(); return; }
                            return async ({ result }) => {
                                if (result.type === 'success') { actionError = null; await invalidateAll(); }
                                else if (result.type === 'failure') {
                                    actionError = String((result.data as { error?: string } | undefined)?.error ?? '撤销失败，请重试');
                                }
                            };
                        }}>
                        <input type="hidden" name="token" value={s.token}>
                        <button>撤销</button>
                    </form>
                </td>
            </tr>
            {/each}
        </tbody>
    </table>
    {/if}
</div>

<style>
    /* 页面自身留边距（勿用 :global(body)——会连 topnav 一起缩进，且各页互相污染） */
    .settings-page { font-family: system-ui, sans-serif; padding: 1.5rem; }
    .muted { color: var(--rr-text-muted); }
    .form-error { color: var(--rr-danger); font-size: 0.9rem; }
    table { border-collapse: collapse; }
    th, td { border: 1px solid var(--rr-border); padding: 0.4rem 0.8rem; text-align: left; }
</style>
