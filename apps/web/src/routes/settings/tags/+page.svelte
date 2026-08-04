<script lang="ts">
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    let { data } = $props();
    let editing = $state<string | null>(null);
</script>

<h1>标签管理</h1>
<table>
    <thead><tr><th>名称</th><th>文档数</th><th></th></tr></thead>
    <tbody>
        {#each data.tags as t (t.id)}
            <tr>
                <td>
                    {#if editing === t.name}
                        <form method="POST" action="?/rename" use:enhance={() => async ({ result }) => {
                            if (result.type === 'success') { editing = null; await invalidateAll(); }
                        }}>
                            <input type="hidden" name="old" value={t.name}>
                            <input name="name" value={t.name} autofocus>
                            <button type="submit">保存</button>
                            <button type="button" onclick={() => (editing = null)}>取消</button>
                        </form>
                    {:else}
                        {t.name}
                    {/if}
                </td>
                <td>{t.docCount}</td>
                <td>
                    <button onclick={() => (editing = t.name)}>重命名</button>
                    <form method="POST" action="?/delete" use:enhance={({ cancel }) => {
                        if (!confirm(`删除标签「${t.name}」？将移除所有文档的该标签关联。`)) { cancel(); return; }
                        return async ({ result }) => { if (result.type === 'success') await invalidateAll(); };
                    }}>
                        <input type="hidden" name="name" value={t.name}>
                        <button>删除</button>
                    </form>
                </td>
            </tr>
        {/each}
    </tbody>
</table>

<style>
    :global(body) { font-family: system-ui, sans-serif; padding: 1.5rem; }
    table { border-collapse: collapse; margin-top: 1rem; }
    th, td { border: 1px solid #d0d7de; padding: 0.4rem 0.8rem; text-align: left; }
    form { display: inline-flex; gap: 0.3rem; }
</style>
