<script lang="ts">
    import FolderTree from '$components/FolderTree.svelte';
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    let { data } = $props();
    let currentDir = $derived(data.currentDir);
    async function goto(id: string | null) {
        const url = new URL(location.href);
        if (id) url.searchParams.set('dir', id); else url.searchParams.delete('dir');
        history.pushState({}, '', url);
        await invalidateAll();
    }
</script>

<div class="fm">
    <aside class="fm-left">
        <FolderTree folders={data.folders} currentId={currentDir} onSelect={goto} />
    </aside>
    <section class="fm-right">
        <h1>{currentDir ? '子目录' : '根目录'}</h1>
        <form class="create-folder" method="POST" action="?/createFolder" use:enhance={() => async ({ result }) => { if (result.type === 'success') await invalidateAll(); }}>
            <input name="name" placeholder="新文件夹名" required>
            <button>新建文件夹</button>
        </form>
        {#if data.children.length === 0}
            <p class="muted">空空如也。让 Agent 通过 MCP 上传文档吧。</p>
        {:else}
            <ul class="items">
                {#each data.children as item (item.id)}
                    <li>
                        {#if item.type === 'folder'}
                            <a href="/?dir={item.id}">📁 {item.name}</a>
                        {:else}
                            <a href="/d/{item.id}">📄 {item.name}</a>
                            <span class="size">{item.sizeBytes} B</span>
                        {/if}
                        <form class="inline" method="POST" action="?/rename" use:enhance={() => async ({ result }) => { if (result.type === 'success') await invalidateAll(); }}>
                            <input type="hidden" name="id" value={item.id}>
                            <input name="name" value={item.name} required>
                            <button>✏ 重命名</button>
                        </form>
                    </li>
                {/each}
            </ul>
        {/if}
    </section>
</div>

<style>
    .fm { display: flex; gap: 1.5rem; padding: 1.5rem; font-family: system-ui, sans-serif; }
    .fm-left { width: 16rem; flex-shrink: 0; border-right: 1px solid #d0d7de; padding-right: 1rem; }
    .fm-right { flex: 1; }
    .create-folder { margin: 1rem 0; display: flex; gap: 0.5rem; }
    .items { list-style: none; padding: 0; }
    .items li { padding: 0.5rem 0; display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
    .items > li > a:first-child { min-width: 12rem; }
    .items a { color: #0969da; text-decoration: none; }
    .items a:hover { text-decoration: underline; }
    .size { color: #57606a; font-size: 0.85em; }
    .inline { display: inline-flex; gap: 0.25rem; margin-left: auto; }
    .muted { color: #57606a; }
</style>
