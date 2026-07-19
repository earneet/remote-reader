<script lang="ts">
    import FolderTree from '$components/FolderTree.svelte';
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    let { data } = $props();
    let currentDir = $derived(data.currentDir);
    let movingId: string | null = $state(null);
    async function goto(id: string | null) {
        const url = new URL(location.href);
        if (id) url.searchParams.set('dir', id); else url.searchParams.delete('dir');
        history.pushState({}, '', url);
        await invalidateAll();
    }
    function startMove(id: string) { movingId = id; }
    async function pickTarget(targetId: string | null) {
        if (!movingId) return;
        const fd = new FormData();
        fd.set('id', movingId);
        fd.set('target', targetId ?? 'root');
        const r = await fetch('?/move', { method: 'POST', body: fd });
        if (r.ok) { movingId = null; await invalidateAll(); }
    }
</script>

<div class="fm">
    <aside class="fm-left">
        <FolderTree
            folders={data.folders}
            currentId={currentDir}
            selecting={movingId !== null}
            onSelect={movingId !== null ? pickTarget : goto}
        />
        {#if movingId !== null}
            <p class="hint">移动模式：点左树选目标，或<button class="link" onclick={() => (movingId = null)}>取消</button></p>
        {/if}
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
                        {#if movingId === item.id}
                            <span class="hint">← 在左树点目标</span>
                            <button onclick={() => (movingId = null)}>取消</button>
                        {:else}
                            <button class="move-btn" onclick={() => startMove(item.id)}>📂 移动</button>
                        {/if}
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
    .inline { display: inline-flex; gap: 0.25rem; }
    .hint { color: #2da44e; font-size: 0.9em; }
    .link { border: none; background: none; color: #0969da; cursor: pointer; padding: 0; }
    .move-btn { margin-left: auto; }
    .muted { color: #57606a; }
</style>
