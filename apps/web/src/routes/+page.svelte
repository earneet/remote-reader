<script lang="ts">
    import FolderTree from '$components/FolderTree.svelte';
    import { enhance } from '$app/forms';
    import { goto, invalidateAll } from '$app/navigation';
    let { data } = $props();
    let currentDir = $derived(data.currentDir);
    let movingId = $state<string | null>(null);
    let moveError = $state<string | null>(null);
    let editingId = $state<string | null>(null);
    let taggingId = $state<string | null>(null);
    let tagInput = $state('');

    // 用 SvelteKit 标准导航：原生 history.pushState 只改地址栏、不更新 SvelteKit 内部 url，
    // invalidateAll 重跑 load 时 url.searchParams 仍读旧 dir → 切目录无反应。
    async function selectDir(id: string | null) {
        await goto(id ? `/?dir=${encodeURIComponent(id)}` : '/', { keepFocus: true, noScroll: true });
    }

    function startMove(id: string) { movingId = id; moveError = null; }
    async function pickTarget(targetId: string | null) {
        if (!movingId) return;
        const fd = new FormData();
        fd.set('id', movingId);
        fd.set('target', targetId ?? 'root');
        const r = await fetch('?/move', { method: 'POST', body: fd });
        if (r.ok) { movingId = null; moveError = null; await invalidateAll(); }
        else { moveError = '移动失败（目标无效或会造成环路），请重选目标或取消'; }
    }

    function startRename(id: string) { editingId = id; }
    function cancelRename() { editingId = null; }

    // use: action 仅客户端挂载时执行（SSR 无真实 DOM），安全聚焦+全选
    function autofocus(node: HTMLInputElement) {
        node.focus();
        node.select();
    }
</script>

<div class="fm">
    <aside class="fm-left">
        <FolderTree
            folders={data.folders}
            currentId={currentDir}
            selecting={movingId !== null}
            onSelect={movingId !== null ? pickTarget : selectDir}
        />
        {#if movingId !== null}
            <p class="hint">移动模式：点左树选目标，或<button class="link" onclick={() => (movingId = null)}>取消</button></p>
            {#if moveError}<p class="error">{moveError}</p>{/if}
        {/if}
    </aside>
    <section class="fm-right">
        <div class="fm-head">
            <h1>{currentDir ? '子目录' : '根目录'}</h1>
            <form class="create-folder" method="POST" action="?/createFolder" use:enhance={() => async ({ result }) => { if (result.type === 'success') await invalidateAll(); }}>
                <input name="name" placeholder="新文件夹名" required>
                <button class="btn primary" type="submit">+ 新建文件夹</button>
            </form>
        </div>
        {#if data.children.length === 0}
            <p class="muted empty">空空如也。让 Agent 通过 MCP 上传文档吧。</p>
        {:else}
            <ul class="items">
                {#each data.children as item (item.id)}
                    <li class="item" class:editing={editingId === item.id}>
                        {#if editingId === item.id}
                            <form class="rename-form" method="POST" action="?/rename"
                                use:enhance={() => async ({ result }) => {
                                    if (result.type === 'success') { editingId = null; await invalidateAll(); }
                                }}
                            >
                                <input type="hidden" name="id" value={item.id}>
                                <input name="name" value={item.name} required use:autofocus
                                    onkeydown={(e) => { if (e.key === 'Escape') cancelRename(); }}>
                                <button type="submit" class="btn sm primary">保存</button>
                                <button type="button" class="btn sm" onclick={cancelRename}>取消</button>
                            </form>
                        {:else}
                            <span class="name">
                                {#if item.type === 'folder'}
                                    <a href="/?dir={item.id}">📁 {item.name}</a>
                                {:else}
                                    <a href="/d/{item.id}">📄 {item.name}</a>
                                {/if}
                                {#if item.type !== 'folder' && item.sizeBytes != null}
                                    <span class="size">{item.sizeBytes} B</span>
                                {/if}
                            </span>
                            {#if item.type === 'file'}
                                <span class="doc-tags">
                                    {#each (data.tagsByDoc.get(item.id) ?? []) as tg (tg.id)}
                                        <span class="chip-static">{tg.name}</span>
                                    {/each}
                                    {#if taggingId === item.id}
                                        <form class="tag-form" method="POST" action="?/setTags"
                                            use:enhance={() => async ({ result }) => { if (result.type === 'success') { taggingId = null; tagInput = ''; await invalidateAll(); } }}>
                                            <input type="hidden" name="id" value={item.id}>
                                            <input name="tags" value={tagInput || (data.tagsByDoc.get(item.id) ?? []).map(t => t.name).join(', ')}
                                                placeholder="逗号分隔，如 周报, api" use:autofocus
                                                onkeydown={(e) => { if (e.key === 'Escape') { taggingId = null; } }}>
                                            <button type="submit" class="btn sm primary">保存</button>
                                            <button type="button" class="btn sm" onclick={() => (taggingId = null)}>取消</button>
                                        </form>
                                    {:else}
                                        <button class="icon-btn" title="编辑标签" onclick={() => { taggingId = item.id; tagInput = ''; }}>🏷</button>
                                    {/if}
                                </span>
                            {/if}
                            <span class="actions">
                                <button class="icon-btn" title="重命名" onclick={() => startRename(item.id)}>✏</button>
                                {#if movingId === item.id}
                                    <span class="hint">← 左树选目标</span>
                                    <button class="btn sm" onclick={() => (movingId = null)}>取消</button>
                                {:else}
                                    <button class="icon-btn" title="移动到…" onclick={() => startMove(item.id)}>📂</button>
                                {/if}
                                <form class="inline" method="POST" action="?/delete"
                                    use:enhance={({ cancel }) => {
                                        const msg = item.type === 'folder'
                                            ? '确认删除该文件夹？将级联删除其全部内容，且不可恢复。'
                                            : '确认删除该文件？此操作不可恢复。';
                                        if (!confirm(msg)) { cancel(); return; }
                                        return async ({ result }) => { if (result.type === 'success') await invalidateAll(); };
                                    }}
                                >
                                    <input type="hidden" name="id" value={item.id}>
                                    <button class="icon-btn danger" title="删除">🗑</button>
                                </form>
                            </span>
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
    .fm-right { flex: 1; min-width: 0; }
    .fm-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .fm-head h1 { margin: 0; font-size: 1.15rem; }
    .create-folder { display: flex; gap: 0.5rem; }
    .create-folder input {
        padding: 0.35rem 0.6rem; border: 1px solid #d0d7de; border-radius: 5px; font-size: 0.9rem; min-width: 10rem;
    }
    .create-folder input:focus { outline: none; border-color: #0969da; box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.2); }

    .empty { padding: 2rem 0; }

    .items { list-style: none; padding: 0; margin: 1rem 0; }
    .item {
        display: flex; align-items: center; gap: 0.75rem;
        padding: 0.4rem 0.5rem; border-radius: 6px; border-bottom: 1px solid #eaecef;
    }
    .item:last-child { border-bottom: none; }
    .item:hover { background: #f6f8fa; }
    .item.editing { background: #ddf4ff; }

    .name { display: flex; align-items: baseline; gap: 0.5rem; flex: 1; min-width: 0; }
    .name a { color: #0969da; text-decoration: none; overflow-wrap: anywhere; }
    .name a:hover { text-decoration: underline; }
    .size { color: #57606a; font-size: 0.8em; flex-shrink: 0; }

    .actions { display: inline-flex; align-items: center; gap: 0.2rem; flex-shrink: 0; }

    .rename-form { display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0; }
    .rename-form input {
        flex: 1; min-width: 0; padding: 0.3rem 0.5rem;
        border: 1px solid #0969da; border-radius: 5px; font-size: 0.95rem; background: #fff;
    }
    .rename-form input:focus { outline: none; box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.2); }

    .icon-btn {
        border: 1px solid transparent; background: transparent; cursor: pointer;
        padding: 0.35rem 0.5rem; border-radius: 5px; color: #57606a; font-size: 1rem; line-height: 1;
    }
    .icon-btn:hover { background: #fff; border-color: #d0d7de; color: #1f2328; }
    .icon-btn.danger:hover { color: #cf222e; border-color: #cf222e; }

    .btn {
        border: 1px solid #d0d7de; background: #fff; color: #1f2328; cursor: pointer;
        padding: 0.35rem 0.8rem; border-radius: 5px; font-size: 0.85rem; line-height: 1.2;
    }
    .btn.sm { padding: 0.3rem 0.65rem; }
    .btn.primary { background: #1f883d; color: #fff; border-color: #1f883d; }
    .btn.primary:hover { background: #1a7f37; }

    .inline { display: inline-flex; }

    .hint { color: #2da44e; font-size: 0.85em; }
    .error { color: #cf222e; font-size: 0.9em; }
    .link { border: none; background: none; color: #0969da; cursor: pointer; padding: 0; }
    .muted { color: #57606a; }

    .doc-tags { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
    .chip-static { display: inline-block; padding: 0 0.4rem; background: #ddf4ff; color: #0969da; border-radius: 999px; font-size: 0.72rem; }
    .tag-form { display: inline-flex; align-items: center; gap: 0.3rem; }
    .tag-form input { padding: 0.25rem 0.5rem; border: 1px solid #0969da; border-radius: 5px; font-size: 0.8rem; min-width: 12rem; }
</style>
