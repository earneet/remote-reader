<script lang="ts">
    import { invalidateAll } from '$app/navigation';
    import { RECENT_PAGE_SIZE, type RecentDoc, type RecentSort } from '$lib/shared/recent';
    import { folderNamesOf, type TreeFolder } from '$lib/shared/folder-tree';
    import { formatRelative } from '$lib/shared/time';
    import { submitAction, actionErrorMessage } from '$lib/shared/form-action';
    import ActionSheet from '$components/ActionSheet.svelte';
    import InlineNameForm from '$components/InlineNameForm.svelte';
    import InlineTagForm from '$components/InlineTagForm.svelte';
    import RowActions from '$components/RowActions.svelte';

    let {
        initialRows,
        sort,
        folderById,
        scrollRoot,
        movingId,
        onStartMove,
        onCancelMove
    }: {
        initialRows: RecentDoc[];
        sort: RecentSort;
        folderById: Map<string, TreeFolder>;
        scrollRoot: HTMLElement | null;
        movingId: string | null;
        onStartMove: (id: string) => void;
        onCancelMove: () => void;
    } = $props();

    // 本地列表状态：进入 recent 视图时组件挂载、从此初始化；invalidateAll 不重建组件，
    // 故 rows 不被 load 重置——列表不缩回、滚动位置保留的关键（spec §6.2）。
    // svelte-ignore state_referenced_locally
    let rows = $state<RecentDoc[]>([...initialRows]);
    // svelte-ignore state_referenced_locally
    let hasMore = $state(initialRows.length >= RECENT_PAGE_SIZE);
    let loadingMore = $state(false);
    let loadError = $state(false);
    let resyncing = $state(false);
    let editingId = $state<string | null>(null);
    let renameValue = $state('');
    let taggingId = $state<string | null>(null);
    let tagInput = $state('');
    let sentinel = $state<HTMLElement | null>(null);
    let sheet = $state<ActionSheet | null>(null);
    let sheetId = $state<string | null>(null);
    // P2-10：失败反馈 + 防重复提交（fetch 版与目录视图 enhance 版同语义）
    let renameError = $state<string | null>(null);
    let tagError = $state<string | null>(null);
    let deleteError = $state<string | null>(null);
    let busyId = $state<string | null>(null);

    const pathOf = (item: RecentDoc): string => folderNamesOf(folderById, item.parentId).join(' / ');

    function cursorOfLast(): string | null {
        const last = rows[rows.length - 1];
        if (!last) return null;
        const ts = sort === 'viewed' ? last.ownerViewedAt : last.updatedAt;
        return `${ts}_${last.id}`;
    }

    // 无限滚动追加（spec §6.2）；keyset 语义下按 id 去重防边界重复
    async function loadMore(): Promise<void> {
        if (loadingMore || !hasMore || resyncing) return;
        const before = cursorOfLast();
        if (!before) return;
        loadingMore = true;
        loadError = false;
        try {
            const r = await fetch(`/api/recent?sort=${sort}&before=${encodeURIComponent(before)}`);
            if (!r.ok) throw new Error(String(r.status));
            const data = await r.json() as { items: RecentDoc[] };
            const seen = new Set(rows.map((x) => x.id));
            rows.push(...data.items.filter((x) => !seen.has(x.id)));
            hasMore = data.items.length >= RECENT_PAGE_SIZE;
        } catch {
            loadError = true;
        } finally {
            loadingMore = false;
        }
    }

    // re-sync：按当前已加载深度整体重拉（spec §6.2 操作后刷新）；父组件经 bind:this 调用。
    // 网络失败降级 invalidateAll（列表缩回可接受）。
    export async function reSync(): Promise<void> {
        if (resyncing) return;
        resyncing = true;
        // 已知良性竞态：limit 在入口读取，飞行中的 loadMore 若在读取后、替换前 append，
        // 替换会把深度缩回 limit（自愈：再滚动即恢复；排序单调性由 id 去重保证）
        const limit = Math.max(RECENT_PAGE_SIZE, rows.length);
        try {
            const r = await fetch(`/api/recent?sort=${sort}&limit=${limit}`);
            if (!r.ok) throw new Error(String(r.status));
            const data = await r.json() as { items: RecentDoc[] };
            rows = data.items;
            hasMore = data.items.length >= limit;
        } catch {
            await invalidateAll();
        } finally {
            resyncing = false;
        }
    }

    function startRename(item: RecentDoc): void {
        editingId = item.id;
        renameValue = item.name;
        renameError = null;
    }

    function openSheet(id: string): void {
        sheetId = id;
        sheet?.show();
    }

    function onSheetAction(key: string): void {
        const id = sheetId;
        const item = rows.find((x) => x.id === id);
        sheetId = null;
        if (!item) return;
        if (key === 'rename') startRename(item);
        else if (key === 'tags') { taggingId = item.id; tagInput = item.tags.map((t) => t.name).join(', '); tagError = null; }
        else if (key === 'move') onStartMove(item.id);
        else if (key === 'delete') void doDelete(item);
    }

    async function doRename(id: string, name: string): Promise<void> {
        if (!name) return;
        busyId = id;
        const status = await submitAction('rename', { id, name });
        busyId = null;
        if (status === 200) {
            editingId = null;
            renameError = null;
            await reSync();
        } else {
            renameError = actionErrorMessage(status); // 失败保持编辑态 + 展示原因，可改可取消
        }
    }

    async function doSetTags(id: string, tags: string): Promise<void> {
        busyId = id;
        const status = await submitAction('setTags', { id, tags });
        busyId = null;
        if (status === 200) {
            taggingId = null;
            tagInput = '';
            tagError = null;
            await reSync();
        } else {
            tagError = actionErrorMessage(status);
        }
    }

    async function doDelete(item: RecentDoc): Promise<void> {
        if (!confirm('确认删除该文件？此操作不可恢复。')) return;
        busyId = item.id;
        const status = await submitAction('delete', { id: item.id });
        busyId = null;
        if (status === 200 || status === 404) {
            deleteError = null;
            rows = rows.filter((x) => x.id !== item.id); // 乐观移除：reSync 失败也不残留已删行（终审跟进）
            await invalidateAll(); // 刷左树计数（rows 本地态不被重置，零代价——Task 6 审查跟进）
            await reSync();
        } else {
            deleteError = actionErrorMessage(status);
        }
    }

    // 哨兵 observer：root 为右栏滚动容器，rootMargin 提前 600px 预载（spec §6.2）。
    // 依赖仅 scrollRoot/sentinel；loadMore 内部状态在异步回调里读，不进依赖。SSR 不执行。
    $effect(() => {
        const root = scrollRoot;
        const target = sentinel;
        if (!root || !target) return;
        const io = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) void loadMore();
        }, { root, rootMargin: '600px' });
        io.observe(target);
        return () => io.disconnect();
    });
</script>

{#if rows.length === 0}
    <p class="muted empty">{sort === 'viewed' ? '还没有浏览记录，打开过的文档会出现在这里。' : '还没有文档，让 Agent 通过 MCP 上传吧。'}</p>
{:else}
    <ul class="items">
        {#each rows as item (item.id)}
            <li class="item" class:editing={editingId === item.id}>
                {#if editingId === item.id}
                    <InlineNameForm
                        initialName={renameValue}
                        busy={busyId === item.id}
                        error={renameError}
                        onSave={(name) => void doRename(item.id, name)}
                        onCancel={() => (editingId = null)}
                    />
                {:else}
                    <span class="name">
                        <a href="/d/{item.id}">📄 {item.name}</a>
                        {#if item.storageTier === 'cold'}<span class="chip-static cold-chip">☁️ 已归档</span>{/if}
                        {#if item.sizeBytes != null}<span class="size">{item.sizeBytes} B</span>{/if}
                    </span>
                    {#if pathOf(item)}
                        <span class="path" title={pathOf(item)}>{pathOf(item)}</span>
                    {/if}
                    {#if sort === 'viewed'}
                        <span class="time" title={new Date(item.ownerViewedAt ?? item.updatedAt).toLocaleString()}>看过 · {formatRelative(item.ownerViewedAt ?? item.updatedAt)}</span>
                    {:else}
                        <span class="time" title={new Date(item.updatedAt).toLocaleString()}>{formatRelative(item.updatedAt)}</span>
                    {/if}
                    <span class="doc-tags">
                        {#each item.tags as tg (tg.id)}
                            <span class="chip-static">{tg.name}</span>
                        {/each}
                        {#if taggingId === item.id}
                            <InlineTagForm
                                initialValue={tagInput}
                                busy={busyId === item.id}
                                error={tagError}
                                onSave={(tags) => void doSetTags(item.id, tags)}
                                onCancel={() => (taggingId = null)}
                            />
                        {:else}
                            <button class="icon-btn desktop-only" title="编辑标签"
                                onclick={() => { taggingId = item.id; tagInput = item.tags.map((t) => t.name).join(', '); }}>🏷</button>
                        {/if}
                    </span>
                    <RowActions
                        moving={movingId === item.id}
                        busy={busyId === item.id}
                        onMore={() => openSheet(item.id)}
                        onRename={() => startRename(item)}
                        onMove={() => onStartMove(item.id)}
                        onCancelMove={onCancelMove}
                        onDelete={() => void doDelete(item)}
                    />
                {/if}
            </li>
        {/each}
    </ul>
    {#if hasMore}
        <div class="sentinel" bind:this={sentinel} aria-hidden="true"></div>
    {/if}
    {#if loadingMore}<p class="muted">加载中…</p>{/if}
    {#if loadError}
        <p class="error">加载失败 <button class="link" onclick={() => void loadMore()}>点击重试</button></p>
    {/if}
    {#if deleteError}
        <p class="error">{deleteError} <button class="link" onclick={() => (deleteError = null)}>关闭</button></p>
    {/if}
{/if}

<ActionSheet
    bind:this={sheet}
    label="文档操作"
    actions={[
        { key: 'rename', label: '重命名' },
        { key: 'tags', label: '编辑标签' },
        { key: 'move', label: '移动到…' },
        { key: 'delete', label: '删除', danger: true }
    ]}
    onSelect={onSheetAction}
/>

<style>
    .empty { padding: 2rem 0; }
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

    .path {
        color: var(--rr-text-muted); font-size: 0.8em; flex-shrink: 1;
        max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .time { color: var(--rr-text-muted); font-size: 0.8em; flex-shrink: 0; font-variant-numeric: tabular-nums; }

    .doc-tags { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }

    .sentinel { height: 1px; }
    .muted { color: var(--rr-text-muted); }
    .error { color: var(--rr-danger); font-size: 0.9em; }
    .link { border: none; background: none; color: var(--rr-link); cursor: pointer; padding: 0; }

    /* 窄屏：面包屑折行到第二行（spec §6.4） */
    @media (max-width: 768px) {
        .item { flex-wrap: wrap; }
        .item:active { background: var(--rr-hover-bg); }
        .path { order: 5; flex-basis: 100%; max-width: none; white-space: normal; }
    }
</style>
