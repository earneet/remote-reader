<script lang="ts">
    import { clampZoom, nextZoom, formatZoom, ZOOM_STEP } from '$lib/shared/mermaid-zoom';

    let { container, html }: { container: HTMLDivElement | undefined; html: string } = $props();

    let fs = $state<{ html: string } | null>(null);
    let zoom = $state(1);
    let browserFs = $state(false);
    let overlayEl: HTMLDivElement | undefined = $state(undefined);
    let rotated = $state(false);

    // 横屏展示：设备竖屏(portrait)时把表格旋转 90° 铺满屏幕长边；设备已横屏(landscape)则不转，避免反向旋转。
    // 用户点 ⛶ 进 overlay 时按当前方向决定；之后旋转设备会触发 orientationchange 自动同步。
    function syncRotation() {
        rotated = !window.matchMedia('(orientation: landscape)').matches;
    }

    function ensureFsBtn(outer: HTMLElement, t: HTMLTableElement) {
        outer.classList.add('rr-wide');
        if (!outer.querySelector('.rr-table-fs-btn')) {
            const btn = document.createElement('button');
            btn.className = 'rr-table-fs-btn';
            btn.type = 'button';
            btn.textContent = '⛶';
            btn.title = '全屏查看表格';
            btn.addEventListener('click', () => openFullscreen(t.outerHTML));
            outer.appendChild(btn);
        }
    }

    function openFullscreen(tableHtml: string) {
        fs = { html: tableHtml };
        zoom = 1;
        browserFs = false;
        syncRotation();
    }

    function closeOverlay() {
        if (document.fullscreenElement) document.exitFullscreen()?.catch(() => {});
        browserFs = false;
        fs = null;
    }

    function toggleFs() {
        browserFs = !browserFs;
        const el = overlayEl;
        if (browserFs) el?.requestFullscreen?.().catch(() => {});
        else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
    }

    function onFsChange() {
        browserFs = !!document.fullscreenElement;
    }

    function focusOnMount(node: HTMLElement) {
        const prev = document.activeElement as HTMLElement | null;
        node.focus();
        return {
            destroy() {
                if (prev && typeof prev.focus === 'function') prev.focus();
            }
        };
    }

    function gestures(node: HTMLElement) {
        let pointers = new Map<number, { x: number; y: number }>();
        let pinchDist = 0;
        let zoomStart = 1;
        const down = (e: PointerEvent) => {
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            try { node.setPointerCapture(e.pointerId); } catch {}
            if (pointers.size === 2) {
                const [a, b] = [...pointers.values()];
                pinchDist = Math.hypot(a.x - b.x, a.y - b.y);
                zoomStart = zoom;
            }
        };
        const move = (e: PointerEvent) => {
            if (!pointers.has(e.pointerId)) return;
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size >= 2 && pinchDist > 0) {
                const [a, b] = [...pointers.values()];
                const d = Math.hypot(a.x - b.x, a.y - b.y);
                zoom = clampZoom(zoomStart * (d / pinchDist));
            }
        };
        const up = (e: PointerEvent) => {
            pointers.delete(e.pointerId);
            try { node.releasePointerCapture(e.pointerId); } catch {}
            if (pointers.size < 2) pinchDist = 0;
        };
        const wheel = (e: WheelEvent) => {
            // H1: 仅 Ctrl/Meta+滚轮缩放，普通滚轮/触控板平移放行给原生滚动
            if (!(e.ctrlKey || e.metaKey)) return;
            e.preventDefault();
            zoom = clampZoom(zoom - e.deltaY * 0.0015);
        };
        node.addEventListener('pointerdown', down);
        node.addEventListener('pointermove', move);
        node.addEventListener('pointerup', up);
        node.addEventListener('pointercancel', up);
        node.addEventListener('wheel', wheel, { passive: false });
        return {
            destroy() {
                node.removeEventListener('pointerdown', down);
                node.removeEventListener('pointermove', move);
                node.removeEventListener('pointerup', up);
                node.removeEventListener('pointercancel', up);
                node.removeEventListener('wheel', wheel);
            }
        };
    }

    $effect(() => {
        const _ = html;
        const root = container;
        if (!root) return;
        root.querySelectorAll('.rr-table-fs-btn').forEach((b) => b.remove());
        const wraps = Array.from(root.querySelectorAll<HTMLElement>('.rr-table-wrap'));
        const states = new WeakMap<HTMLElement, 'none' | 'mobile' | 'desktop'>();
        const baseWidthOf = (w: HTMLElement) => {
            const r = w.closest('.markdown-body') as HTMLElement | null;
            if (!r) return w.clientWidth;
            const cs = getComputedStyle(r);
            return r.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        };
        const apply = (w: HTMLElement) => {
            const t = w.querySelector('table');
            if (!t) return;
            const outer = w.parentElement;
            const base = baseWidthOf(w);
            // 比较表格内容固有宽(t.scrollWidth)与正文容器宽(base)——两者均不受外扩 class 影响，
            // 故判定稳定，不会因 toggle class → 尺寸变 → RO 触发 → 翻转判定而无限抖动。
            const overflows = t.scrollWidth > base + 8;
            let next: 'none' | 'mobile' | 'desktop';
            if (!overflows) next = 'none';
            else next = window.matchMedia('(max-width: 768px)').matches ? 'mobile' : 'desktop';
            if (states.get(w) === next) return;
            states.set(w, next);
            w.classList.toggle('rr-shrink', next === 'mobile');
            if (outer) {
                outer.classList.remove('rr-wide');
                outer.classList.toggle('rr-wide-d', next === 'desktop');
                if (next === 'mobile' && t.scrollWidth > base + 8) ensureFsBtn(outer, t);
            }
        };
        wraps.forEach(apply);
        let raf = 0;
        const rerun = () => {
            cancelAnimationFrame(raf);
            raf = requestAnimationFrame(() => wraps.forEach(apply));
        };
        const ro = new ResizeObserver(() => rerun());
        ro.observe(root);
        window.addEventListener('resize', rerun);
        return () => {
            cancelAnimationFrame(raf);
            ro.disconnect();
            window.removeEventListener('resize', rerun);
        };
    });

    $effect(() => {
        if (!fs) return;
        const mq = window.matchMedia('(orientation: landscape)');
        const onOrient = () => syncRotation();
        mq.addEventListener('change', onOrient);
        document.addEventListener('fullscreenchange', onFsChange);
        return () => {
            mq.removeEventListener('change', onOrient);
            document.removeEventListener('fullscreenchange', onFsChange);
        };
    });
</script>

{#if fs}
    <div
        class="rr-tbl-overlay"
        class:rr-fs={browserFs}
        bind:this={overlayEl}
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        use:focusOnMount
        onclick={(e) => { if (e.target === e.currentTarget) closeOverlay(); }}
        onkeydown={(e) => { if (e.key === 'Escape') closeOverlay(); }}
    >
        <div class="rr-tbl-bar">
            <span class="rr-tbl-label">表格 · {formatZoom(zoom)}</span>
            <div class="rr-tbl-ctrls">
                <button type="button" title="缩小" onclick={() => (zoom = nextZoom(zoom, -ZOOM_STEP))}>−</button>
                <button type="button" title="重置" onclick={() => (zoom = 1)}>⊙</button>
                <button type="button" title="放大" onclick={() => (zoom = nextZoom(zoom, ZOOM_STEP))}>+</button>
                <button type="button" title="全屏" onclick={toggleFs}>⛶</button>
                <button type="button" title="关闭" onclick={closeOverlay}>✕</button>
            </div>
        </div>
        <div class="rr-tbl-stage" class:rotated={rotated} use:gestures>
            <div class="rr-tbl-scroll" style={`transform: scale(${zoom})`}>{@html fs.html}</div>
        </div>
    </div>
{/if}

<style>
    .rr-tbl-overlay {
        position: fixed; inset: 0; z-index: 1000;
        background: rgba(0, 0, 0, 0.8);
        display: flex; flex-direction: column;
    }
    .rr-tbl-bar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 10px; flex-shrink: 0; position: relative; z-index: 2;
        background: var(--rr-bg, #f6f8fa);
        border-bottom: 1px solid var(--rr-border-soft, #eaecef);
    }
    .rr-tbl-label { font-size: 12px; color: var(--rr-text-muted, #57606a); }
    .rr-tbl-ctrls { display: flex; gap: 4px; }
    .rr-tbl-ctrls button {
        min-width: 28px; height: 28px; padding: 0 6px;
        border: 1px solid var(--rr-border, #d0d7de); border-radius: 5px;
        background: var(--rr-card-bg, #fff); color: var(--rr-text-muted, #57606a);
        cursor: pointer; font-size: 14px; line-height: 1;
    }
    .rr-tbl-stage {
        flex: 1; overflow: auto;
        touch-action: pan-x pan-y;
        padding: 12px; box-sizing: border-box;
        display: flex;
    }
    .rr-tbl-stage.rotated {
        position: fixed;
        top: 50%; left: 50%;
        width: 100vh; height: 100vw;
        transform: translate(-50%, -50%) rotate(-90deg);
        z-index: 1;
    }
    .rr-tbl-scroll {
        margin: auto;
        width: 100%;
        transform-origin: center center;
        box-sizing: border-box;
        user-select: text; -webkit-user-select: text;
        background: var(--rr-card-bg, #fff); color: var(--rr-text, #1f2328);
        padding: 8px; border-radius: 8px;
    }
    .rr-tbl-scroll :global(table) { border-collapse: separate; border-spacing: 0; width: 100%; }
    .rr-tbl-scroll :global(th),
    .rr-tbl-scroll :global(td) {
        overflow-wrap: break-word;
        border: 1px solid var(--rr-border, #d0d7de);
        padding: 0.4rem 0.8rem; color: var(--rr-text, #1f2328);
    }
    .rr-tbl-scroll :global(th) {
        position: sticky; top: 0; background: var(--rr-card-bg, #fff); z-index: 1;
    }
    .rr-tbl-scroll :global(a) { color: var(--rr-link, #0969da); }
    .rr-tbl-scroll :global(:not(pre) > code) {
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
        background: var(--rr-inline-code-bg, #eff2f5); color: var(--rr-inline-code-text, #bc4b00);
        padding: 0.15em 0.35em; border-radius: 4px;
    }
    .rr-tbl-overlay.rr-fs .rr-tbl-bar {
        position: absolute; top: 8px; right: 8px; z-index: 10;
        background: transparent; border: none;
    }
    .rr-tbl-overlay.rr-fs .rr-tbl-label { display: none; }
</style>
