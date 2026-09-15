<script lang="ts">
    // 文档行的操作按钮簇（目录视图与 RecentList 共用，A-1 第一步抽取）：
    // 移动端 ⋯（开 ActionSheet）+ 桌面 inline 操作（重命名/移动/删除），移动进行中切换为提示+取消。
    // 行为回调全部由父级注入；确认弹窗、请求发起都在父级
    let {
        moving = false,
        busy = false,
        onMore,
        onRename,
        onMove,
        onCancelMove,
        onDelete
    }: {
        moving?: boolean;
        busy?: boolean;
        onMore?: () => void;
        onRename: () => void;
        onMove: () => void;
        onCancelMove: () => void;
        onDelete: () => void;
    } = $props();
</script>

<span class="actions">
    {#if onMore}
        <button type="button" class="icon-btn more-btn mobile-only" aria-label="更多操作" onclick={onMore}>
            <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"></path></svg>
        </button>
    {/if}
    <span class="desktop-only inline-actions">
        <button class="icon-btn" title="重命名" onclick={onRename}>✏</button>
        {#if moving}
            <span class="hint">← 左树选目标</span>
            <button class="btn sm" onclick={onCancelMove}>取消</button>
        {:else}
            <button class="icon-btn" title="移动到…" onclick={onMove}>📂</button>
        {/if}
        <button class="icon-btn danger" title="删除" disabled={busy} onclick={onDelete}>🗑</button>
    </span>
</span>

<style>
    .actions { display: inline-flex; align-items: center; gap: 0.2rem; flex-shrink: 0; }
    .more-btn { padding: 0.45rem 0.5rem; }
    .inline-actions { display: inline-flex; align-items: center; gap: 0.2rem; }
    .hint { color: var(--rr-success); font-size: 0.85em; }
</style>
