<script lang="ts">
    import FolderTree from '$components/FolderTree.svelte';
    import RecentList from '$components/RecentList.svelte';
    import ActionSheet from '$components/ActionSheet.svelte';
    import ActionMenu from '$components/ActionMenu.svelte';
    import ShareDialog from '$components/ShareDialog.svelte';
    import FileStateIcon from '$components/FileStateIcon.svelte';
    import InlineNameForm from '$components/InlineNameForm.svelte';
    import InlineTagForm from '$components/InlineTagForm.svelte';
    import RowActions from '$components/RowActions.svelte';
    import { ancestorChainOf, type TreeFolder } from '$lib/shared/folder-tree';
    import { lockBodyScroll, unlockBodyScroll } from '$lib/shared/body-scroll';
    import { createOverlayHistory } from '$lib/shared/overlay-history';
    import { submitAction, actionErrorMessage } from '$lib/shared/form-action';
    import { rowActions } from '$lib/shared/row-menu';
    import { fetchShareUrl, revokeDocShares } from '$lib/shared/share-api';
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
    let showCreate = $state(false);
    let sheet = $state<ActionSheet | null>(null);
    let actionMenu = $state<ActionMenu | null>(null);
    let shareDialog = $state<ShareDialog | null>(null);
    // 菜单上下文（移动 sheet 与桌面下拉共用）：构造条件菜单项（转私有仅 shared 时出）
    let menuCtx = $state<{ id: string; type: string; shared: boolean } | null>(null);
    let drawerOpen = $state(false);
    let drawerRef = $state<HTMLDialogElement | null>(null);
    let menuBtn = $state<HTMLButtonElement | null>(null);
    const drawerHistory = createOverlayHistory();
    // D-4：同一 storageKey 的两份树实例状态互不同步（aside 移动端 display:none 但仍挂载）。
    // 改为断点互斥挂载——任意时刻仅一实例存活，折叠状态经 localStorage（每次变更即持久化）跨断点承接
    let isMobile = $state(false);
    $effect(() => {
        const mq = window.matchMedia('(max-width: 768px)');
        const sync = () => { isMobile = mq.matches; };
        sync();
        mq.addEventListener('change', sync);
        return () => mq.removeEventListener('change', sync);
    });

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
    const crumbs = $derived(view === 'dir' && currentDir ? ancestorChainOf(folderById, currentDir) : []);

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

    function openDrawer(): void {
        drawerOpen = true;
        // SvelteKit pushState（同 URL 浅路由条目）：返回键可关抽屉且不与 SvelteKit 路由的
        // 内部 history 跟踪冲突（原生 history.pushState 会触发 dev warning 并丢内部 state）
        drawerHistory.push();
        drawerRef?.showModal();
        lockBodyScroll();
    }

    // 非返回键关闭须 await popstate 消费完浅路由条目再做后续导航：
    // SvelteKit goto 也 pushState，乱序会把刚推的导航条目弹掉（spec §6.4）。
    // 返回键路径先 markConsumedByPop，此处 consume 为 no-op
    async function closeDrawer(): Promise<void> {
        if (!drawerOpen) return;
        drawerOpen = false;
        drawerRef?.close();
        unlockBodyScroll();
        menuBtn?.focus();
        await drawerHistory.consume();
    }

    // dialog 原生 Esc 关闭不经 closeDrawer，onclose 兜底同步状态
    function onDrawerClose(): void {
        if (drawerOpen) void closeDrawer();
    }

    // 抽屉内选目录：先消费完 history 再 goto（见 consume 注释）
    async function selectFromDrawer(id: string | null): Promise<void> {
        await closeDrawer();
        await selectDir(id);
    }

    // 系统返回键 = 关抽屉而非退出整页（spec §6.4）；popstate 已弹掉条目，标记已消费
    $effect(() => {
        const onPop = () => {
            if (drawerOpen) {
                drawerHistory.markConsumedByPop();
                void closeDrawer();
            }
        };
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    });

    function startMove(id: string) {
        movingId = id; moveError = null;
        // 移动端树在抽屉里：选择模式自动打开抽屉；桌面常驻左树无需弹层
        if (isMobile) openDrawer();
    }
    async function pickTarget(targetId: string | null) {
        if (!movingId) return;
        const status = await submitAction('move', { id: movingId, target: targetId ?? 'root' });
        if (status === 200) {
            movingId = null;
            moveError = null;
            await closeDrawer();
            await invalidateAll();
            await recentRef?.reSync();
        }
        else { moveError = actionErrorMessage(status) + '，请重选目标或取消'; }
    }

    function startRename(id: string) { editingId = id; renameError = null; }
    function cancelRename() { editingId = null; renameError = null; }

    // P2-10：动作失败给出可见反馈（此前 enhance 只处理 success，409 冲突静默无感）
    let actionError = $state<string | null>(null);
    let renameError = $state<string | null>(null);
    let tagError = $state<string | null>(null);
    let createError = $state<string | null>(null);
    // 行内表单防重复提交（SvelteKit 2.x enhance 无自动禁用，已核实 forms.js）
    let busyId = $state<string | null>(null);

    function failureMessage(result: { type: string; status?: number; data?: { error?: string } }): string {
        if (result.type === 'failure' && result.data?.error) return String(result.data.error);
        return actionErrorMessage(result.status ?? 0);
    }

    async function doRename(id: string, name: string): Promise<void> {
        busyId = id; renameError = null;
        const status = await submitAction('rename', { id, name });
        busyId = null;
        if (status === 200) { editingId = null; await invalidateAll(); }
        else renameError = actionErrorMessage(status);
    }

    async function doSetTags(id: string, tags: string): Promise<void> {
        busyId = id; tagError = null;
        const status = await submitAction('setTags', { id, tags });
        busyId = null;
        if (status === 200) { taggingId = null; tagInput = ''; await invalidateAll(); }
        else tagError = actionErrorMessage(status);
    }

    // 菜单项来自 lib/shared/row-menu 单源（评审跟进：与 RecentList 收敛，防两份漂移）
    // ⋯ 入口路由：移动端底部 sheet，桌面锚定下拉
    function openRowMenu(anchor: HTMLElement, id: string, type: string, shared: boolean): void {
        menuCtx = { id, type, shared };
        if (isMobile) sheet?.show();
        else actionMenu?.toggle(anchor);
    }

    function onRowAction(key: string): void {
        const it = menuCtx;
        if (!it) return;
        menuCtx = null;
        if (key === 'rename') startRename(it.id);
        else if (key === 'tags') { taggingId = it.id; tagInput = ''; tagError = null; }
        else if (key === 'move') startMove(it.id);
        else if (key === 'share') void doShare(it.id);
        else if (key === 'unshare') void doUnshare(it.id);
        else if (key === 'delete') void doDelete(it.id, it.type);
    }

    // 复制分享链接（get-or-create）：成功后刷新（私有→共享图标翻转）再弹浮层
    async function doShare(id: string): Promise<void> {
        busyId = id;
        try {
            const url = await fetchShareUrl(id);
            if (!url) throw new Error('share failed');
            await invalidateAll();
            await recentRef?.reSync();
            shareDialog?.show(url);
        } catch {
            actionError = '获取分享链接失败，请重试';
        } finally {
            busyId = null;
        }
    }

    // 转为私有：撤销该文档全部分享链接（404=文档已不在也算完成，幂等）
    async function doUnshare(id: string): Promise<void> {
        if (!confirm('转为私有后，该文档的所有分享链接立即失效（已发出的链接将无法再打开），且不可恢复。继续？')) return;
        busyId = id;
        try {
            if (!(await revokeDocShares(id))) throw new Error('unshare failed');
            actionError = null;
            await invalidateAll();
            await recentRef?.reSync();
        } catch {
            actionError = '转为私有失败，请重试';
        } finally {
            busyId = null;
        }
    }

    // 移动端 ⋯ 菜单与桌面行内删除的统一入口：确认后 fetch 直调 form action
    async function doDelete(id: string, type: string): Promise<void> {
        const msg = type === 'folder'
            ? '确认删除该文件夹？将级联删除其全部内容，且不可恢复。'
            : '确认删除该文件？此操作不可恢复。';
        if (!confirm(msg)) return;
        busyId = id;
        const status = await submitAction('delete', { id });
        busyId = null;
        if (status === 200 || status === 404) {
            actionError = null;
            await invalidateAll();
            await recentRef?.reSync();
        } else {
            actionError = actionErrorMessage(status);
        }
    }
</script>

<div class="fm">
    {#if !isMobile}
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
    {/if}
    <section class="fm-right" bind:this={rightPane}>
        <div class="fm-head">
            <div class="fm-title">
                <button type="button" class="icon-btn menu-btn mobile-only" bind:this={menuBtn}
                    aria-label="打开目录树" onclick={openDrawer}>
                    <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M1 2.75A.75.75 0 0 1 1.75 2h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 2.75Zm0 5A.75.75 0 0 1 1.75 7h12.5a.75.75 0 0 1 0 1.5H1.75A.75.75 0 0 1 1 7.75ZM1.75 12h12.5a.75.75 0 0 1 0 1.5H1.75a.75.75 0 0 1 0-1.5Z"></path></svg>
                </button>
                {#if view === 'dir'}
                    <nav class="crumbs" aria-label="当前目录路径">
                        <button type="button" class="crumb" class:current={crumbs.length === 0}
                            onclick={() => selectDir(null)}>根目录</button>
                        {#each crumbs as c, i}
                            <span class="crumb-sep" aria-hidden="true">/</span>
                            {#if i === crumbs.length - 1}
                                <span class="crumb current" aria-current="page">{c.name}</span>
                            {:else}
                                <button type="button" class="crumb" onclick={() => selectDir(c.id)}>{c.name}</button>
                            {/if}
                        {/each}
                    </nav>
                {:else}
                    <h1>{view === 'recent' ? '最近文档' : '最近浏览'}</h1>
                {/if}
            </div>
            <div class="fm-title">
                {#if view === 'dir'}
                    <!-- 页签恒末位（spec 2026-09-16 §5.8）：新建入口在页签左侧，三视图页签位置一致；
                         action 必须编入 dir：WHATWG 相对解析 "?/createFolder" 会替换整个 query，
                         子目录下丢 dir 参数会把文件夹建到根目录（F1） -->
                    <form class="create-folder desktop-only" method="POST"
                        action={currentDir ? `?dir=${encodeURIComponent(currentDir)}&/createFolder` : '?/createFolder'}
                        use:enhance={() => async ({ formElement, result }) => {
                            if (result.type === 'success') { createError = null; formElement.reset(); await invalidateAll(); }
                            else if (result.type === 'failure') createError = failureMessage(result);
                        }}>
                        <input name="name" placeholder="新文件夹名" required>
                        <button class="btn primary" type="submit">+ 新建文件夹</button>
                    </form>
                    <button type="button" class="btn sm mobile-only" onclick={() => (showCreate = !showCreate)}>＋ 文件夹</button>
                {/if}
                <div class="segmented" role="group" aria-label="视图切换">
                    <button type="button" class="seg-btn" class:active={view === 'dir'}
                        aria-pressed={view === 'dir'} onclick={() => switchView('/')}>目录内容</button>
                    <button type="button" class="seg-btn" class:active={view === 'recent'}
                        aria-pressed={view === 'recent'} onclick={() => switchView('/?view=recent')}>最近文档</button>
                    <button type="button" class="seg-btn" class:active={view === 'viewed'}
                        aria-pressed={view === 'viewed'} onclick={() => switchView('/?view=viewed')}>最近浏览</button>
                </div>
            </div>
            {#if createError && view === 'dir'}<p class="error create-error">{createError}</p>{/if}
            {#if showCreate && view === 'dir'}
                <form class="create-folder mobile-only" method="POST"
                    action={currentDir ? `?dir=${encodeURIComponent(currentDir)}&/createFolder` : '?/createFolder'}
                    use:enhance={() => async ({ formElement, result }) => {
                        if (result.type === 'success') { showCreate = false; createError = null; formElement.reset(); await invalidateAll(); }
                        else if (result.type === 'failure') createError = failureMessage(result);
                    }}>
                    <input name="name" placeholder="新文件夹名" required>
                    <button class="btn primary" type="submit">新建</button>
                    <button type="button" class="btn" onclick={() => (showCreate = false)}>收起</button>
                </form>
            {/if}
        </div>
        {#if actionError}
            <div class="action-error-banner" role="alert">
                {actionError}
                <button type="button" class="link" aria-label="关闭提示" onclick={() => (actionError = null)}>×</button>
            </div>
        {/if}
        {#if view === 'recent'}
            <RecentList
                bind:this={recentRef}
                isMobile={isMobile}
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
                isMobile={isMobile}
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
                                <InlineNameForm
                                    initialName={item.name}
                                    busy={busyId === item.id}
                                    error={renameError}
                                    onSave={(name) => void doRename(item.id, name)}
                                    onCancel={cancelRename}
                                />
                            {:else}
                                <span class="name">
                                    {#if item.type === 'folder'}
                                        <a href="/?dir={item.id}"><FileStateIcon type="folder" /> {item.name}</a>
                                    {:else}
                                        <a href="/d/{item.id}"><FileStateIcon type="file" shared={item.shared} /> {item.name}</a>
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
                                            <InlineTagForm
                                                initialValue={tagInput || (data.tagsByDoc.get(item.id) ?? []).map(t => t.name).join(', ')}
                                                busy={busyId === item.id}
                                                error={tagError}
                                                onSave={(tags) => void doSetTags(item.id, tags)}
                                                onCancel={() => (taggingId = null)}
                                            />
                                        {/if}
                                    </span>
                                {/if}
                                <RowActions
                                    moving={movingId === item.id}
                                    onMore={(btn) => openRowMenu(btn, item.id, item.type, item.shared)}
                                    onCancelMove={() => (movingId = null)}
                                />
                            {/if}
                        </li>
                    {/each}
                </ul>
            {/if}
        {/if}
    </section>
</div>

<ActionSheet
    bind:this={sheet}
    label="文档操作"
    actions={menuCtx ? rowActions(menuCtx) : []}
    onSelect={onRowAction}
/>
<ActionMenu
    bind:this={actionMenu}
    label="文档操作"
    actions={menuCtx ? rowActions(menuCtx) : []}
    onSelect={onRowAction}
/>
<ShareDialog bind:this={shareDialog} />

<dialog class="drawer" bind:this={drawerRef} onclose={onDrawerClose} aria-label="目录导航"
    onclick={(e) => { if (e.target === drawerRef) void closeDrawer(); }}>
    {#if movingId !== null}
        <p class="hint">选择移动目标，或<button class="link" onclick={() => (movingId = null)}>取消</button></p>
        {#if moveError}<p class="error">{moveError}</p>{/if}
    {/if}
    {#if isMobile}
        <FolderTree
            folders={treeFolders}
            currentId={view === 'dir' ? currentDir : undefined}
            selecting={movingId !== null}
            onSelect={movingId !== null ? pickTarget : selectFromDrawer}
            storageKey="rr:tree-expanded:{data.user?.id ?? 'anon'}"
        />
    {/if}
</dialog>

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
        width: 16rem; flex-shrink: 0; border-right: 1px solid var(--rr-border); padding-right: 1rem;
        overflow-y: auto; overscroll-behavior: contain;
    }
    .fm-right {
        flex: 1; min-width: 0;
        overflow-y: auto; overscroll-behavior: contain;
    }

    /* 移动端（spec 2026-09-14）：树收进抽屉（.fm-left 隐藏、dialog 承载），内容独占页面宽度，
       单一滚动轴（页面整体滚）；触屏以 :active 替代不存在的 hover 反馈。 */
    @media (max-width: 768px) {
        .fm { flex-direction: column; gap: 0; padding: 0.75rem 1rem; height: auto; }
        .fm-left { display: none; }
        .fm-right { overflow-y: visible; }
        .fm-head { gap: 0.6rem; }
        .create-folder.mobile-only { display: flex !important; width: 100%; }
        .create-folder.mobile-only input { flex: 1; min-width: 0; }
        .item { padding: 0.5rem 0.25rem; }
        .item:active { background: var(--rr-hover-bg); }
        .crumbs { flex: 1; }
        .menu-btn { flex-shrink: 0; }
    }
    .fm-head { display: flex; align-items: center; justify-content: space-between; gap: 1rem; flex-wrap: wrap; }
    .fm-head h1 { margin: 0; font-size: 1.15rem; }
    .fm-title { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
    .crumbs { display: flex; align-items: center; gap: 0.25rem; min-width: 0; overflow-x: auto; scrollbar-width: none; font-size: 1.1rem; }
    .crumbs::-webkit-scrollbar { display: none; }
    .crumb { border: none; background: none; color: var(--rr-link); cursor: pointer; padding: 0.2rem 0.3rem; border-radius: 4px; white-space: nowrap; font-size: inherit; }
    .crumb:hover { background: var(--rr-hover-bg); }
    .crumb.current { color: var(--rr-text); font-weight: 600; white-space: nowrap; padding: 0.2rem 0.3rem; }
    .crumb-sep { color: var(--rr-text-muted); flex-shrink: 0; }
    .menu-btn { padding: 0.45rem 0.5rem; }
    .segmented { display: inline-flex; border: 1px solid var(--rr-border); border-radius: 6px; overflow: hidden; }
    .seg-btn {
        border: none; background: var(--rr-btn-bg); color: var(--rr-btn-text); cursor: pointer;
        padding: 0.3rem 0.75rem; font-size: 0.85rem; line-height: 1.4;
    }
    .seg-btn + .seg-btn { border-left: 1px solid var(--rr-border); }
    .seg-btn.active { background: var(--rr-accent-soft); color: var(--rr-link); font-weight: 600; }
    .seg-btn:focus-visible { outline: 2px solid var(--rr-accent); outline-offset: -2px; }
    .create-folder { display: flex; gap: 0.5rem; }
    .create-folder input {
        padding: 0.35rem 0.6rem; border: 1px solid var(--rr-input-border); border-radius: 5px; font-size: 0.9rem; min-width: 10rem;
        background: var(--rr-input-bg); color: var(--rr-text);
    }
    .create-folder input:focus { outline: none; border-color: var(--rr-accent); box-shadow: 0 0 0 2px var(--rr-focus-ring); }

    .empty { padding: 2rem 0; }

    .action-error-banner {
        display: flex; align-items: center; justify-content: space-between; gap: 0.75rem;
        margin: 0.75rem 0 0; padding: 0.45rem 0.75rem;
        border: 1px solid var(--rr-danger); border-radius: 6px;
        color: var(--rr-danger); font-size: 0.9rem; background: var(--rr-card-bg);
    }
    .create-error { margin: 0.25rem 0 0; }

    .items { list-style: none; padding: 0; margin: 1rem 0; }
    .item {
        display: flex; align-items: center; gap: 0.75rem;
        padding: 0.4rem 0.5rem; border-radius: 6px; border-bottom: 1px solid var(--rr-border-soft);
    }
    .item:last-child { border-bottom: none; }
    .item:hover { background: var(--rr-hover-bg); }
    .item.editing { background: var(--rr-accent-soft); }

    .name { display: flex; align-items: baseline; gap: 0.5rem; flex: 1; min-width: 0; }
    .name a { color: var(--rr-link); text-decoration: none; overflow-wrap: anywhere; }
    .name a:hover { text-decoration: underline; }
    .cold-chip { color: var(--rr-text-muted); font-weight: 400; }
    .size { color: var(--rr-text-muted); font-size: 0.8em; flex-shrink: 0; }

    .hint { color: var(--rr-success); font-size: 0.85em; }
    .error { color: var(--rr-danger); font-size: 0.9em; }
    .link { border: none; background: none; color: var(--rr-link); cursor: pointer; padding: 0; }
    .muted { color: var(--rr-text-muted); }

    .doc-tags { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
    .drawer {
        position: fixed; inset: 0 auto 0 0;
        width: min(80vw, 20rem); max-width: none; max-height: none;
        margin: 0; border: none; border-right: 1px solid var(--rr-border);
        border-radius: 0; padding: 1rem 0.75rem;
        background: var(--rr-card-bg); color: var(--rr-text);
        font-family: system-ui, sans-serif;
    }
    .drawer::backdrop { background: var(--rr-scrim); }
    .drawer[open] { animation: drawer-in 180ms ease-out; }
    @keyframes drawer-in { from { transform: translateX(-100%); } }
    @media (min-width: 769px) { .drawer { display: none !important; } }

    .doc-tags { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
</style>
