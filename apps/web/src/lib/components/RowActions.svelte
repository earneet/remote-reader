<script lang="ts">
    // 文档行操作入口（目录视图与 RecentList 共用，spec 2026-09-16 §5.2）：
    // 单一 ⋯ 按钮双端可见——桌面开 ActionMenu 下拉、移动开 ActionSheet 底部菜单，父级按 isMobile 路由。
    // onMore 把按钮元素回传作下拉锚点。移动进行中：桌面在 ⋯ 前显示提示+取消（移动端取消走抽屉内提示）。
    let {
        moving = false,
        onMore,
        onCancelMove
    }: {
        moving?: boolean;
        onMore: (anchor: HTMLElement) => void;
        onCancelMove: () => void;
    } = $props();
</script>

<span class="actions">
    {#if moving}
        <span class="hint desktop-only">← 左树选目标</span>
        <button type="button" class="btn sm desktop-only" onclick={onCancelMove}>取消</button>
    {/if}
    <button type="button" class="icon-btn more-btn" aria-label="更多操作"
        onclick={(e) => onMore(e.currentTarget)}>
        <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"></path></svg>
    </button>
</span>

<style>
    .actions { display: inline-flex; align-items: center; gap: 0.2rem; flex-shrink: 0; }
    .more-btn { padding: 0.45rem 0.5rem; }
    .hint { color: var(--rr-success); font-size: 0.85em; }
</style>
