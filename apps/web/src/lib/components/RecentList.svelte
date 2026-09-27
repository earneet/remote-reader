<script lang="ts">
    import { invalidateAll } from '$app/navigation';
    import { RECENT_PAGE_SIZE, type RecentDoc, type RecentSort } from '$lib/shared/recent';
    import { folderNamesOf, type TreeFolder } from '$lib/shared/folder-tree';
    import { formatRelative } from '$lib/shared/time';
    import { formatBytes } from '$lib/shared/format';
    import FileStateIcon from '$components/FileStateIcon.svelte';
    import InlineNameForm from '$components/InlineNameForm.svelte';
    import InlineTagForm from '$components/InlineTagForm.svelte';
    import RowActions from '$components/RowActions.svelte';
    import type { RowActionOrchestrator } from '$lib/shared/row-orchestrator.svelte';

    let {
        orchestrator,
        initialRows,
        sort,
        folderById,
        movingId,
        onCancelMove
    }: {
        /** 行操作编排单源（R-06）：与 FM 目录视图共用宿主页同一实例——操作语义零漂移 */
        orchestrator: RowActionOrchestrator;
        initialRows: RecentDoc[];
        sort: RecentSort;
        folderById: Map<string, TreeFolder>;
        movingId: string | null;
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
    let sentinel = $state<HTMLElement | null>(null);
    // 删除乐观移除经 orchestrator.removedIds 过滤（refresh 失败也不残留已删行）
    const visibleRows = $derived(rows.filter((x) => !orchestrator.isRemoved(x.id)));

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

    // 哨兵 observer：root 用视口（null）而非右栏元素——≤768px 布局下 .fm-right 是
    // height:auto 不裁剪的普通块，哨兵恒在其盒内 → 交叉状态永不翻转，移动端无限滚动哑火。
    // 桌面右栏几乎占满视口，rootMargin 600px 预载语义不变。依赖仅 sentinel；
    // loadMore 内部状态在异步回调里读，不进依赖。SSR 不执行。
    $effect(() => {
        const target = sentinel;
        if (!target) return;
        const io = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) void loadMore();
        }, { root: null, rootMargin: '600px' });
        io.observe(target);
        return () => io.disconnect();
    });
</script>

{#if visibleRows.length === 0}
    <p class="muted empty">{sort === 'viewed' ? '还没有浏览记录，打开过的文档会出现在这里。' : '还没有文档，让 Agent 通过 MCP 上传吧。'}</p>
{:else}
    <ul class="items">
        {#each visibleRows as item (item.id)}
            <li class="item" class:editing={orchestrator.editingId === item.id}>
                {#if orchestrator.editingId === item.id}
                    <InlineNameForm
                        initialName={orchestrator.renameValue}
                        busy={orchestrator.busyId === item.id}
                        error={orchestrator.renameError}
                        onSave={(name) => void orchestrator.doRename(item.id, name)}
                        onCancel={() => orchestrator.cancelRename()}
                    />
                {:else}
                    <span class="name">
                        <a href="/d/{item.id}"><FileStateIcon type={item.type} shared={item.shared} /> {item.name}</a>
                        {#if item.storageTier === 'cold'}<span class="chip-static cold-chip">☁️ 已归档</span>{/if}
                        {#if item.sizeBytes != null}<span class="size">{formatBytes(item.sizeBytes)}</span>{/if}
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
                        {#if orchestrator.taggingId === item.id}
                            <InlineTagForm
                                initialValue={orchestrator.tagInput}
                                busy={orchestrator.busyId === item.id}
                                error={orchestrator.tagError}
                                onSave={(tags) => void orchestrator.doSetTags(item.id, tags)}
                                onCancel={() => (orchestrator.taggingId = null)}
                            />
                        {/if}
                    </span>
                    <RowActions
                        moving={movingId === item.id}
                        onMore={(btn) => orchestrator.openRowMenu(btn, item)}
                        onCancelMove={onCancelMove}
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
{/if}

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
