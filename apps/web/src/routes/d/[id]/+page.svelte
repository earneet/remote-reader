<script lang="ts">
    import MarkdownViewer from '$components/MarkdownViewer.svelte';
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    let { data } = $props();
    let editing = $state(false);
    let input = $derived(
        editing ? (data.tags.map(t => t.name).join(', ')) : ''
    );
</script>

<svelte:head><title>{data.title}</title></svelte:head>

<a href="/" class="back">← 返回我的文档</a>

<div class="tag-bar">
    {#if !editing}
        {#each data.tags as t (t.id)}<span class="chip-static">{t.name}</span>{/each}
        <button class="btn sm" onclick={() => (editing = true)}>🏷 编辑标签</button>
    {:else}
        <form method="POST" action="?/setTags" use:enhance={() => async ({ result }) => {
            if (result.type === 'success') { editing = false; await invalidateAll(); }
        }}>
            <input name="tags" value={input} placeholder="逗号分隔" autofocus
                onkeydown={(e) => { if (e.key === 'Escape') editing = false; }}>
            <button type="submit" class="btn sm primary">保存</button>
            <button type="button" class="btn sm" onclick={() => (editing = false)}>取消</button>
        </form>
    {/if}
</div>

<MarkdownViewer html={data.html} />

<style>
    .back { display: inline-block; max-width: 760px; margin: 0 auto; padding: 1rem 2rem 0; color: #0969da; }
    .tag-bar { max-width: 760px; margin: 0 auto; padding: 0.5rem 2rem; display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
    .chip-static { display: inline-block; padding: 0 0.5rem; background: #ddf4ff; color: #0969da; border-radius: 999px; font-size: 0.78rem; }
    .btn { border: 1px solid #d0d7de; background: #fff; color: #1f2328; cursor: pointer; padding: 0.3rem 0.7rem; border-radius: 5px; font-size: 0.8rem; }
    .btn.sm { padding: 0.25rem 0.6rem; }
    .btn.primary { background: #1f883d; color: #fff; border-color: #1f883d; }
    .tag-bar input { padding: 0.25rem 0.5rem; border: 1px solid #0969da; border-radius: 5px; font-size: 0.82rem; min-width: 14rem; }
</style>
