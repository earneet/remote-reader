<script lang="ts">
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    let { data, form } = $props();
    let editing = $state<string | null>(null);
    let renameError = $state<string | null>(null);
    let deleteError = $state<string | null>(null);
    function failMessage(result: { data?: { error?: string } }, fallback: string): string {
        return String(result.data?.error ?? fallback);
    }
</script>

<div class="settings-page">
    <h1>标签管理</h1>
    <!-- no-JS 原生提交时 fail() 经 SSR 重渲染以 form prop 送达（enhance 路径走 renameError/deleteError） -->
    {#if form?.error}<p class="form-error" role="alert">{form.error}</p>{/if}
    <table>
        <thead><tr><th>名称</th><th>文档数</th><th></th></tr></thead>
        <tbody>
            {#each data.tags as t (t.name)}
                <tr>
                    <td>
                        {#if editing === t.name}
                            <form method="POST" action="?/rename" use:enhance={() => async ({ result }) => {
                                if (result.type === 'success') { editing = null; renameError = null; await invalidateAll(); }
                                else if (result.type === 'failure') renameError = failMessage(result, '重命名失败，请重试');
                            }}>
                                <input type="hidden" name="old" value={t.name}>
                                <input name="name" value={t.name} autofocus>
                                <button type="submit">保存</button>
                                <button type="button" onclick={() => { editing = null; renameError = null; }}>取消</button>
                            </form>
                            {#if renameError}<span class="form-error" role="alert">{renameError}</span>{/if}
                        {:else}
                            {t.name}
                        {/if}
                    </td>
                    <td>{t.docCount}</td>
                    <td>
                        <button onclick={() => { editing = t.name; renameError = null; }}>重命名</button>
                        <form method="POST" action="?/delete" use:enhance={({ cancel }) => {
                            if (!confirm(`删除标签「${t.name}」？将移除所有文档的该标签关联。`)) { cancel(); return; }
                            return async ({ result }) => {
                                if (result.type === 'success') { deleteError = null; await invalidateAll(); }
                                else if (result.type === 'failure') deleteError = failMessage(result, '删除失败，请重试');
                            };
                        }}>
                            <input type="hidden" name="name" value={t.name}>
                            <button>删除</button>
                        </form>
                    </td>
                </tr>
            {/each}
        </tbody>
    </table>
    {#if deleteError}<p class="form-error" role="alert">{deleteError}</p>{/if}
</div>

<style>
    /* 页面自身留边距（勿用 :global(body)——会连 topnav 一起缩进，且各页互相污染） */
    .settings-page { font-family: system-ui, sans-serif; padding: 1.5rem; }
    table { border-collapse: collapse; margin-top: 1rem; }
    th, td { border: 1px solid var(--rr-border); padding: 0.4rem 0.8rem; text-align: left; }
    form { display: inline-flex; gap: 0.3rem; }
    .form-error { color: var(--rr-danger); font-size: 0.85rem; }
</style>
