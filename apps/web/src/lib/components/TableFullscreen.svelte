<script lang="ts">
    import { clampZoom, nextZoom, formatZoom, ZOOM_STEP, ZOOM_WHEEL_FACTOR } from '$lib/shared/zoom';
    import { overlayOnMount } from '$lib/shared/overlay-mount';
    import { overlayGestures } from '$lib/shared/overlay-gestures';
    import type { GestureOpts } from '$lib/shared/overlay-gestures';
    import { trapTabKey } from '$lib/shared/focus-trap';
    import { browserFullscreen, type BrowserFullscreenCtl } from '$lib/shared/browser-fullscreen';

    let { container, html }: { container: HTMLDivElement | undefined; html: string } = $props();

    let fs = $state<{ html: string } | null>(null);
    let zoom = $state(1);
    let rotated = $state(false);
    // 挂载时由 use:browserFullscreen 装入实现（组件侧零全屏状态）
    let fsCtl: BrowserFullscreenCtl = { toggle: () => {}, exit: () => {} };

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
        syncRotation();
    }

    function closeOverlay() {
        fsCtl.exit();
        fs = null;
    }

    // 手势快照：pinch 基准式（onPinchStart 快照 → onZoom 里 zoomStart * factor）；
    // wheel 仅 Ctrl/Meta（H1：普通滚轮放行原生滚动）；不传 onPan/onSwipe（表格 overlay 无拖动/切页）
    let pinchZoomStart = 1;
    const gesturesOpts: GestureOpts = {
        onPinchStart: () => { pinchZoomStart = zoom; },
        onZoom: (factor) => { zoom = clampZoom(pinchZoomStart * factor); },
        onWheelZoom: (deltaY) => { zoom = clampZoom(zoom - deltaY * ZOOM_WHEEL_FACTOR); },
        wheelRequiresCtrl: true
    };

    $effect(() => {
        const _ = html;
        const root = container;
        if (!root) return;
        root.querySelectorAll('.rr-table-fs-btn, .rr-table-expand-btn').forEach((b) => b.remove());
        const wraps = Array.from(root.querySelectorAll<HTMLElement>('.rr-table-wrap'));
        const states = new WeakMap<HTMLElement, 'none' | 'mobile'>();
        const expanded = new Set<HTMLElement>();
        const naturalOf = new WeakMap<HTMLElement, number>();
        const baseWidthOf = (w: HTMLElement) => {
            const r = w.closest('.markdown-body') as HTMLElement | null;
            if (!r) return w.clientWidth;
            const cs = getComputedStyle(r);
            return r.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
        };
        // 桌面端"展开/收缩"：按用户点击态(expanded)同步 class、外扩宽度、按钮文案
        const syncExpand = (outer: HTMLElement) => {
            const isExp = expanded.has(outer);
            outer.classList.toggle('rr-wide-d', isExp);
            const btn = outer.querySelector<HTMLButtonElement>('.rr-table-expand-btn');
            if (btn) btn.textContent = isExp ? '收缩' : '展开';
            if (isExp) {
                const natural = naturalOf.get(outer) ?? 0;
                const target = Math.min(window.innerWidth * 0.95, natural + 8);
                const cur = parseFloat(outer.style.width) || 0;
                if (Math.abs(cur - target) > 1) outer.style.width = target + 'px';
            } else if (outer.style.width) {
                outer.style.width = '';
            }
        };
        const ensureExpandBtn = (outer: HTMLElement) => {
            if (outer.querySelector('.rr-table-expand-btn')) return;
            const btn = document.createElement('button');
            btn.className = 'rr-table-expand-btn';
            btn.type = 'button';
            btn.textContent = '展开';
            btn.title = '展开表格（利用屏幕两侧留白）';
            btn.addEventListener('click', () => {
                if (expanded.has(outer)) expanded.delete(outer);
                else expanded.add(outer);
                syncExpand(outer);
            });
            outer.appendChild(btn);
        };
        const apply = (w: HTMLElement) => {
            const t = w.querySelector('table');
            if (!t) return;
            const outer = w.parentElement;
            const base = baseWidthOf(w);
            const isMobile = window.matchMedia('(max-width: 768px)').matches;
            // 量"理想宽"(非 shrink 态、max-content 不换行宽)：scrollWidth 是被容器压缩换行后的渲染宽，
            // 会漏判"靠换行勉强塞进容器、理想宽其实更大"的表。基于非 shrink 态测量避免 shrink↔判定 RO 循环。
            const wasShrink = w.classList.contains('rr-shrink');
            if (wasShrink) w.classList.remove('rr-shrink');
            const prevW = t.style.width;
            t.style.width = 'max-content';
            const natural = t.offsetWidth;
            t.style.width = prevW;
            if (wasShrink) w.classList.add('rr-shrink');
            const overflows = natural > base + 8;
            if (isMobile) {
                // 移动端策略不变：shrink + ⛊ 全屏 overlay
                const next: 'none' | 'mobile' = overflows ? 'mobile' : 'none';
                if (states.get(w) !== next) {
                    states.set(w, next);
                    w.classList.toggle('rr-shrink', next === 'mobile');
                    if (outer) {
                        outer.classList.remove('rr-wide');
                        if (next === 'mobile' && t.scrollWidth > base + 8) ensureFsBtn(outer, t);
                    }
                }
                // 跨断点切换到移动端时，清桌面展开态
                if (outer) {
                    expanded.delete(outer);
                    outer.classList.remove('rr-wide-d');
                    if (outer.style.width) outer.style.width = '';
                }
                return;
            }
            // 桌面端：宽表显示"展开"按钮，默认不外扩（原始正文宽 + 横向滚动），用户点击才外扩
            w.classList.remove('rr-shrink');
            if (!outer) return;
            outer.classList.remove('rr-wide');
            const fb = outer.querySelector('.rr-table-fs-btn');
            if (fb) fb.remove();
            if (overflows) {
                naturalOf.set(outer, natural);
                ensureExpandBtn(outer);
                syncExpand(outer);
            } else {
                expanded.delete(outer);
                naturalOf.delete(outer);
                outer.classList.remove('rr-wide-d');
                if (outer.style.width) outer.style.width = '';
                const eb = outer.querySelector('.rr-table-expand-btn');
                if (eb) eb.remove();
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
        return () => {
            mq.removeEventListener('change', onOrient);
        };
    });
</script>

{#if fs}
    <div
        class="rr-tbl-overlay"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        use:overlayOnMount
        use:browserFullscreen={fsCtl}
        onclick={(e) => { if (e.target === e.currentTarget) closeOverlay(); }}
        onkeydown={(e) => {
            if (e.key === 'Escape') closeOverlay();
            trapTabKey(e, e.currentTarget);
        }}
    >
        <div class="rr-tbl-bar">
            <span class="rr-tbl-label">表格 · {formatZoom(zoom)}</span>
            <div class="rr-tbl-ctrls">
                <button type="button" title="缩小" onclick={() => (zoom = nextZoom(zoom, -ZOOM_STEP))}>−</button>
                <button type="button" title="重置" onclick={() => (zoom = 1)}>⊙</button>
                <button type="button" title="放大" onclick={() => (zoom = nextZoom(zoom, ZOOM_STEP))}>+</button>
                <button type="button" title="全屏" onclick={() => fsCtl.toggle()}>⛶</button>
                <button type="button" title="关闭" onclick={closeOverlay}>✕</button>
            </div>
        </div>
        <div class="rr-tbl-stage" class:rotated={rotated} use:overlayGestures={gesturesOpts}>
            <div class="rr-tbl-scroll" style={`transform: scale(${zoom})`}>{@html fs.html}</div>
        </div>
    </div>
{/if}

<style>
    .rr-tbl-overlay {
        position: fixed; inset: 0; z-index: 1000;
        background: var(--rr-scrim-strong);
        display: flex; flex-direction: column;
    }
    .rr-tbl-bar {
        display: flex; align-items: center; justify-content: space-between;
        padding: 6px 10px; flex-shrink: 0; position: relative; z-index: 2;
        background: var(--rr-bg);
        border-bottom: 1px solid var(--rr-border-soft);
    }
    .rr-tbl-label { font-size: 12px; color: var(--rr-text-muted); }
    .rr-tbl-ctrls { display: flex; gap: 4px; }
    .rr-tbl-ctrls button {
        min-width: 28px; height: 28px; padding: 0 6px;
        border: 1px solid var(--rr-border); border-radius: 5px;
        background: var(--rr-card-bg); color: var(--rr-text-muted);
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
        background: var(--rr-card-bg); color: var(--rr-text);
        padding: 8px; border-radius: 8px;
    }
    .rr-tbl-scroll :global(table) { border-collapse: separate; border-spacing: 0; width: 100%; }
    .rr-tbl-scroll :global(th),
    .rr-tbl-scroll :global(td) {
        overflow-wrap: break-word;
        border: 1px solid var(--rr-border);
        padding: 0.4rem 0.8rem; color: var(--rr-text);
    }
    .rr-tbl-scroll :global(th) {
        position: sticky; top: 0; background: var(--rr-card-bg); z-index: 1;
    }
    .rr-tbl-scroll :global(a) { color: var(--rr-link); }
    .rr-tbl-scroll :global(:not(pre) > code) {
        font-family: ui-monospace, "SF Mono", Menlo, monospace;
        background: var(--rr-inline-code-bg); color: var(--rr-inline-code-text);
        padding: 0.15em 0.35em; border-radius: 4px;
    }
    /* 全屏 class 由 use:browserFullscreen 运行时添加（模板静态分析不可见）→ 选择器须 :global */
    :global(.rr-tbl-overlay.rr-fs .rr-tbl-bar) {
        position: absolute; top: 8px; right: 8px; z-index: 10;
        background: transparent; border: none;
    }
    :global(.rr-tbl-overlay.rr-fs .rr-tbl-label) { display: none; }
</style>
