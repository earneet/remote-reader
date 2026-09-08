<script lang="ts">
    import { invalidateAll } from '$app/navigation';
    import type { RecentDoc } from '$lib/shared/recent';
    import { RECENT_PAGE_SIZE } from '$lib/shared/recent';
    import { folderNamesOf, type TreeFolder } from '$lib/shared/folder-tree';
    import { formatRelative } from '$lib/shared/time';

    let {
        initialRows,
        folderById,
        scrollRoot,
        movingId,
        onStartMove,
        onCancelMove
    }: {
        initialRows: RecentDoc[];
        folderById: Map<string, TreeFolder>;
        scrollRoot: HTMLElement | null;
        movingId: string | null;
        onStartMove: (id: string) => void;
        onCancelMove: () => void;
    } = $props();

    // 本地列表状态：进入 recent 视图时组件挂载、从此初始化；invalidateAll 不重建组件，
    // 故 rows 不被 load 重置——列表不缩回、滚动位置保留的关键（spec §6.2）。
    let rows = $state<RecentDoc[]>([...initialRows]);
    let hasMore = $state(initialRows.length >= RECENT_PAGE_SIZE);
    let loadingMore = $state(false);
    let loadError = $state(false);
    let resyncing = $state(false);
    let editingId = $state<string | null>(null);
    let renameValue = $state('');
    let taggingId = $state<string | null>(null);
    let tagInput = $state('');
    let sentinel = $state<HTMLElement | null>(null);

    const pathOf = (item: RecentDoc): string => folderNamesOf(folderById, item.parentId).join(' / ');

    // use: action 仅客户端挂载时执行（SSR 无真实 DOM），安全聚焦+全选（与页面同款）
    function autofocus(node: HTMLInputElement) {
        node.focus();
        node.select();
    }

    // SvelteKit form action 直调（与页面 pickTarget 的 move 同款做法）：成功返回 true
    async function submitAction(action: string, fields: Record<string, string>): Promise<boolean> {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) fd.append(k, v);
        const r = await fetch(`?/${action}`, { method: 'POST', body: fd });
        return r.ok;
    }

    function cursorOfLast(): string | null {
        const last = rows[rows.length - 1];
        return last ? `${last.updatedAt}_${last.id}` : null;
    }

    // 无限滚动追加（spec §6.2）；keyset 语义下按 id 去重防边界重复
    async function loadMore(): Promise<void> {
        if (loadingMore || !hasMore || resyncing) return;
        const before = cursorOfLast();
        if (!before) return;
        loadingMore = true;
        loadError = false;
        try {
            const r = await fetch(`/api/recent?before=${encodeURIComponent(before)}`);
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
            const r = await fetch(`/api/recent?limit=${limit}`);
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
    }

    async function doRename(id: string): Promise<void> {
        const name = renameValue.trim();
        if (!name) return;
        if (await submitAction('rename', { id, name })) {
            editingId = null;
            await reSync();
        }
        // 失败保持编辑态：与目录视图 enhance 失败同样不强制反馈，用户可重试或取消
    }

    async function doSetTags(id: string): Promise<void> {
        if (await submitAction('setTags', { id, tags: tagInput })) {
            taggingId = null;
            tagInput = '';
            await reSync();
        }
    }

    async function doDelete(item: RecentDoc): Promise<void> {
        if (!confirm('确认删除该文件？此操作不可恢复。')) return;
        if (await submitAction('delete', { id: item.id })) {
            await invalidateAll(); // 刷左树计数（rows 本地态不被重置，零代价——Task 6 审查跟进）
            await reSync();
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
    <p class="muted empty">还没有文档，让 Agent 通过 MCP 上传吧。</p>
{:else}
    <ul class="items">
        {#each rows as item (item.id)}
            <li class="item" class:editing={editingId === item.id}>
                {#if editingId === item.id}
                    <form class="rename-form" onsubmit={(e) => { e.preventDefault(); void doRename(item.id); }}>
                        <input value={renameValue} required use:autofocus
                            oninput={(e) => (renameValue = e.currentTarget.value)}
                            onkeydown={(e) => { if (e.key === 'Escape') editingId = null; }}>
                        <button type="submit" class="btn sm primary">保存</button>
                        <button type="button" class="btn sm" onclick={() => (editingId = null)}>取消</button>
                    </form>
                {:else}
                    <span class="name">
                        <a href="/d/{item.id}">📄 {item.name}</a>
                        {#if item.storageTier === 'cold'}<span class="chip-static cold-chip">☁️ 已归档</span>{/if}
                        {#if item.sizeBytes != null}<span class="size">{item.sizeBytes} B</span>{/if}
                    </span>
                    {#if pathOf(item)}
                        <span class="path" title={pathOf(item)}>{pathOf(item)}</span>
                    {/if}
                    <span class="time" title={new Date(item.updatedAt).toLocaleString()}>{formatRelative(item.updatedAt)}</span>
                    <span class="doc-tags">
                        {#each item.tags as tg (tg.id)}
                            <span class="chip-static">{tg.name}</span>
                        {/each}
                        {#if taggingId === item.id}
                            <form class="tag-form" onsubmit={(e) => { e.preventDefault(); void doSetTags(item.id); }}>
                                <input value={tagInput} placeholder="逗号分隔，如 周报, api" use:autofocus
                                    oninput={(e) => (tagInput = e.currentTarget.value)}
                                    onkeydown={(e) => { if (e.key === 'Escape') taggingId = null; }}>
                                <button type="submit" class="btn sm primary">保存</button>
                                <button type="button" class="btn sm" onclick={() => (taggingId = null)}>取消</button>
                            </form>
                        {:else}
                            <button class="icon-btn" title="编辑标签"
                                onclick={() => { taggingId = item.id; tagInput = item.tags.map((t) => t.name).join(', '); }}>🏷</button>
                        {/if}
                    </span>
                    <span class="actions">
                        <button class="icon-btn" title="重命名" onclick={() => startRename(item)}>✏</button>
                        {#if movingId === item.id}
                            <span class="hint">← 左树选目标</span>
                            <button class="btn sm" onclick={onCancelMove}>取消</button>
                        {:else}
                            <button class="icon-btn" title="移动到…" onclick={() => onStartMove(item.id)}>📂</button>
                        {/if}
                        <button class="icon-btn danger" title="删除" onclick={() => void doDelete(item)}>🗑</button>
                    </span>
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
    /* 与目录视图行样式同源（Svelte 样式作用域隔离，组件各持一份） */
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

    .path {
        color: #57606a; font-size: 0.8em; flex-shrink: 1;
        max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .time { color: #57606a; font-size: 0.8em; flex-shrink: 0; font-variant-numeric: tabular-nums; }

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

    .doc-tags { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
    .chip-static { display: inline-block; padding: 0 0.4rem; background: #ddf4ff; color: #0969da; border-radius: 999px; font-size: 0.72rem; }
    .tag-form { display: inline-flex; align-items: center; gap: 0.3rem; }
    .tag-form input { padding: 0.25rem 0.5rem; border: 1px solid #0969da; border-radius: 5px; font-size: 0.8rem; min-width: 12rem; }

    .sentinel { height: 1px; }
    .muted { color: #57606a; }
    .error { color: #cf222e; font-size: 0.9em; }
    .hint { color: #2da44e; font-size: 0.85em; }
    .link { border: none; background: none; color: #0969da; cursor: pointer; padding: 0; }

    /* 窄屏：面包屑折行到第二行（spec §6.4） */
    @media (max-width: 768px) {
        .item { flex-wrap: wrap; }
        .path { order: 5; flex-basis: 100%; max-width: none; white-space: normal; }
    }
</style>
