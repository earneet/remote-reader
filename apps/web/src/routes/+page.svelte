<script lang="ts">
    import FolderTree from '$components/FolderTree.svelte';
    import RecentList from '$components/RecentList.svelte';
    import type { TreeFolder } from '$lib/shared/folder-tree';
    import { enhance } from '$app/forms';
    import { goto, invalidateAll } from '$app/navigation';
    let { data } = $props();
    let currentDir = $derived(data.currentDir);
    let movingId = $state<string | null>(null);
    let moveError = $state<string | null>(null);
    let editingId = $state<string | null>(null);
    let taggingId = $state<string | null>(null);
    let tagInput = $state('');
    let rightPane = $state<HTMLElement | null>(null);
    let recentRef = $state<{ reSync: () => Promise<void> } | null>(null);

    // 组装目录树入参：folder 行 + 直接子项计数合成 TreeFolder（组件不感知后端结构，spec §5.1）
    const treeFolders = $derived<TreeFolder[]>(
        data.folders.map(fr => {
            const c = data.folderCounts.get(fr.id) ?? { folders: 0, files: 0 };
            return { id: fr.id, name: fr.name, parentId: fr.parentId, childFolders: c.folders, childFiles: c.files };
        })
    );

    const view = $derived(data.view);
    // 面包屑用：folder id → TreeFolder 的 Map（load 已全量加载 folders，零额外查询，spec §6.4）
    const folderById = $derived(new Map(treeFolders.map((f) => [f.id, f] as const)));

    // 用 SvelteKit 标准导航：原生 history.pushState 只改地址栏、不更新 SvelteKit 内部 url，
    // invalidateAll 重跑 load 时 url.searchParams 仍读旧 dir → 切目录无反应。
    // 回顶：切目录 = 进入新目录应从头看起。桌面右栏是独立滚动容器（app-shell），
    // goto 的页面级回顶滚不动它，须手动重置；移动端右栏随页面流滚动，此处为 no-op，
    // 页面回顶由 goto 默认行为完成。左树滚动位置不动——用户"翻树找目录"的进度保留。
    async function selectDir(id: string | null) {
        await goto(id ? `/?dir=${encodeURIComponent(id)}` : '/', { keepFocus: true });
        rightPane?.scrollTo(0, 0);
    }

    async function switchView(url: string) {
        await goto(url, { keepFocus: true });
        rightPane?.scrollTo(0, 0);
    }

    function startMove(id: string) { movingId = id; moveError = null; }
    async function pickTarget(targetId: string | null) {
        if (!movingId) return;
        const fd = new FormData();
        fd.set('id', movingId);
        fd.set('target', targetId ?? 'root');
        const r = await fetch('?/move', { method: 'POST', body: fd });
        if (r.ok) {
            movingId = null;
            moveError = null;
            await invalidateAll();
            await recentRef?.reSync();
        }
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
            folders={treeFolders}
            currentId={view === 'dir' ? currentDir : undefined}
            selecting={movingId !== null}
            onSelect={movingId !== null ? pickTarget : selectDir}
            storageKey="rr:tree-expanded:{data.user?.id ?? 'anon'}"
        />
        {#if movingId !== null}
            <p class="hint">移动模式：点左树选目标，或<button class="link" onclick={() => (movingId = null)}>取消</button></p>
            {#if moveError}<p class="error">{moveError}</p>{/if}
        {/if}
    </aside>
    <section class="fm-right" bind:this={rightPane}>
        <div class="fm-head">
            <div class="fm-title">
                <h1>{view === 'recent' ? '最近文档' : view === 'viewed' ? '最近浏览' : currentDir ? '子目录' : '根目录'}</h1>
                <div class="segmented" role="group" aria-label="视图切换">
                    <button type="button" class="seg-btn" class:active={view === 'dir'}
                        aria-pressed={view === 'dir'} onclick={() => switchView('/')}>目录内容</button>
                    <button type="button" class="seg-btn" class:active={view === 'recent'}
                        aria-pressed={view === 'recent'} onclick={() => switchView('/?view=recent')}>最近文档</button>
                    <button type="button" class="seg-btn" class:active={view === 'viewed'}
                        aria-pressed={view === 'viewed'} onclick={() => switchView('/?view=viewed')}>最近浏览</button>
                </div>
            </div>
            {#if view === 'dir'}
                <form class="create-folder" method="POST" action="?/createFolder" use:enhance={() => async ({ result }) => { if (result.type === 'success') await invalidateAll(); }}>
                    <input name="name" placeholder="新文件夹名" required>
                    <button class="btn primary" type="submit">+ 新建文件夹</button>
                </form>
            {/if}
        </div>
        {#if view === 'recent'}
            <RecentList
                bind:this={recentRef}
                initialRows={data.recent}
                sort="updated"
                folderById={folderById}
                scrollRoot={rightPane}
                movingId={movingId}
                onStartMove={startMove}
                onCancelMove={() => (movingId = null)}
            />
        {:else if view === 'viewed'}
            <RecentList
                bind:this={recentRef}
                initialRows={data.viewed}
                sort="viewed"
                folderById={folderById}
                scrollRoot={rightPane}
                movingId={movingId}
                onStartMove={startMove}
                onCancelMove={() => (movingId = null)}
            />
        {:else}
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
                                        {#if item.storageTier === 'cold'}<span class="chip-static cold-chip">☁️ 已归档</span>{/if}
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
        {/if}
    </section>
</div>

<style>
    /* app-shell：顶栏 + 内容区恰好铺满视口（--nav-h 由 +layout 实测注入，-1rem 是 body
       上下 margin），滚动只发生在左右栏内部，页面级滚动条不再出现。
       左右栏均由 flex 交叉轴 stretch 拉满容器高，各自 overflow-y 内部滚。 */
    .fm {
        display: flex; gap: 1.5rem; padding: 1.5rem; font-family: system-ui, sans-serif;
        box-sizing: border-box;
        height: calc(100dvh - var(--nav-h, 53px) - 1rem);
    }
    .fm-left {
        width: 16rem; flex-shrink: 0; border-right: 1px solid #d0d7de; padding-right: 1rem;
        overflow-y: auto; overscroll-behavior: contain;
    }
    .fm-right {
        flex: 1; min-width: 0;
        overflow-y: auto; overscroll-behavior: contain;
    }

    /* 窄屏回到整页滚动：触屏上嵌套双滚动区体验差，纵排 + 页面滚更自然。
       桌面 app-shell 的定高/内部滚动均在此还原（height 回 auto、右栏 overflow 回可见、
       左树改 max-height 限高自己滚）。 */
    @media (max-width: 768px) {
        .fm { flex-direction: column; gap: 1rem; padding: 1rem; height: auto; }
        .fm-left {
            width: auto; max-height: 32vh;
            border-right: none; border-bottom: 1px solid #d0d7de;
            padding: 0 0 0.75rem;
        }
        .fm-right { overflow-y: visible; }
    }
    .fm-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .fm-head h1 { margin: 0; font-size: 1.15rem; }
    .fm-title { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
    .segmented { display: inline-flex; border: 1px solid #d0d7de; border-radius: 6px; overflow: hidden; }
    .seg-btn {
        border: none; background: #f6f8fa; color: #1f2328; cursor: pointer;
        padding: 0.3rem 0.75rem; font-size: 0.85rem; line-height: 1.4;
    }
    .seg-btn + .seg-btn { border-left: 1px solid #d0d7de; }
    .seg-btn.active { background: #ddf4ff; color: #0969da; font-weight: 600; }
    .seg-btn:focus-visible { outline: 2px solid #0969da; outline-offset: -2px; }
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
    .cold-chip { color: #57606a; font-weight: 400; }
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
