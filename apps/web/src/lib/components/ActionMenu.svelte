<script lang="ts">
    // 桌面 ⋯ 下拉菜单（spec 2026-09-16 §5.3）：fixed 定位锚定触发按钮——.fm-right 是 overflow-y:auto
    // 滚动容器，position:absolute 会被裁剪。外点/Esc/滚动关闭，打开聚焦首项，关闭归还焦点。
    // 菜单项与 ActionSheet 同构（{key,label,danger}）；不推 history 条目（桌面无 Android 返回键场景）。
    let {
        label = '操作',
        actions,
        onSelect
    }: {
        label?: string;
        actions: { key: string; label: string; danger?: boolean }[];
        onSelect: (key: string) => void;
    } = $props();

    let menu = $state<HTMLDivElement | null>(null);
    let anchor = $state<HTMLElement | null>(null);
    let open = $state(false);
    let pos = $state({ top: '0px', left: '0px' });

    export function toggle(anchorEl: HTMLElement): void {
        if (open && anchor === anchorEl) { hide(); return; }
        anchor = anchorEl;
        const r = anchorEl.getBoundingClientRect();
        // 右对齐锚点、下弹；视口下缘放不下则上翻（高度按项数估算，菜单 ≤6 项误差可接受）
        const estH = actions.length * 2.3 + 0.8; // rem
        const below = r.bottom + 4;
        const flipUp = below + estH * 16 > window.innerHeight;
        const top = flipUp ? Math.max(8, r.top - 4 - estH * 16) : below;
        pos = { top: `${top}px`, left: `${Math.max(8, r.right)}px` };
        open = true;
        requestAnimationFrame(() => menu?.querySelector<HTMLButtonElement>('button')?.focus());
    }

    export function hide(): void {
        if (!open) return;
        open = false;
        anchor?.focus();
    }

    function pick(key: string): void {
        open = false;
        onSelect(key);
    }

    // 外点（锚点自身除外——再点 ⋯ 走 toggle 关）+ Esc + 任何滚动 → 关
    $effect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            const t = e.target as Node;
            if (menu && !menu.contains(t) && anchor && !anchor.contains(t)) hide();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); hide(); }
        };
        const onScroll = () => hide();
        document.addEventListener('click', onDoc, true);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('scroll', onScroll, true);
        return () => {
            document.removeEventListener('click', onDoc, true);
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('scroll', onScroll, true);
        };
    });
</script>

{#if open}
    <div class="menu" role="group" aria-label={label} bind:this={menu}
        style={`top:${pos.top};left:${pos.left}`}>
        {#each actions as a (a.key)}
            <button type="button" class="menu-item" class:danger={a.danger} onclick={() => pick(a.key)}>
                {a.label}
            </button>
        {/each}
    </div>
{/if}

<style>
    .menu {
        position: fixed; z-index: 100;
        transform: translateX(-100%); /* left=锚点右缘，整体左移自身宽 → 右对齐锚点 */
        min-width: 11rem; padding: 0.3rem;
        background: var(--rr-card-bg); border: 1px solid var(--rr-border); border-radius: 8px;
        box-shadow: 0 4px 14px var(--rr-scrim);
        display: flex; flex-direction: column;
    }
    .menu-item {
        border: none; background: none; cursor: pointer; text-align: left;
        padding: 0.45rem 0.7rem; border-radius: 6px; font-size: 0.92rem;
        color: var(--rr-text);
    }
    .menu-item:hover, .menu-item:focus-visible { background: var(--rr-hover-bg); outline: none; }
    .menu-item.danger { color: var(--rr-danger); }
</style>
