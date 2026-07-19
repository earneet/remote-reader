<script lang="ts">
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    let { data } = $props();
    function abbr(token: string) {
        return token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : token;
    }
</script>

<h1>分享链接</h1>

{#if data.shares.length === 0}
<p class="muted">暂无分享链接。Agent 上传文档时会自动生成。</p>
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
                        return async ({ result }) => { if (result.type === 'success') await invalidateAll(); };
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

<style>
    :global(body) { font-family: system-ui, sans-serif; padding: 1.5rem; }
    .muted { color: #57606a; }
    table { border-collapse: collapse; }
    th, td { border: 1px solid #d0d7de; padding: 0.4rem 0.8rem; text-align: left; }
</style>
