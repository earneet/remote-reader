<script lang="ts">
    import { onMount } from 'svelte';
    import { nextZoom, formatZoom, ZOOM_STEP, clampZoom } from '$lib/shared/mermaid-zoom';

    let { container, html }: { container: HTMLDivElement | undefined; html: string } = $props();

    let fullscreen = $state<{ svg: string; zoom: number; x: number; y: number } | null>(null);
    let browserFs = $state(false);
    let themeObserver: MutationObserver | null = null;
    let cleanups: Array<() => void> = [];

    function currentTheme(): 'light' | 'dark' {
        return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    }

    async function loadMermaid() {
        const m = (await import('mermaid')).default;
        // securityLevel:'strict' 防御深度：与 markdown-it html:false、CSP 同属多层防线
        m.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: currentTheme() === 'dark' ? 'dark' : 'default'
        });
        return m;
    }

    $effect(() => {
        const root = container;
        if (root && html) void renderAll(root);
    });

    async function renderAll(root: HTMLElement): Promise<void> {
        const blocks = Array.from(root.querySelectorAll<HTMLElement>('code.language-mermaid'));
        if (blocks.length === 0) return;
        const mermaid = await loadMermaid();
        for (const code of blocks) {
            const pre = code.parentElement;
            if (!pre || pre.dataset.rrDone === '1') continue;
            pre.dataset.rrDone = '1';
            const raw = code.textContent ?? '';
            try {
                const id = 'mmd-' + Math.random().toString(36).slice(2, 9);
                const { svg } = await mermaid.render(id, raw);
                pre.replaceWith(buildInline(svg, raw));
            } catch (e) {
                console.warn('[mermaid] render failed', e);
                const fb = document.createElement('pre');
                fb.className = 'rr-mermaid-fallback';
                fb.textContent = raw;
                pre.replaceWith(fb);
            }
        }
    }

    function buildInline(svgMarkup: string, raw: string): HTMLElement {
        const wrap = document.createElement('div');
        wrap.className = 'rr-mermaid-inline';
        wrap.dataset.rrRaw = encodeURIComponent(raw);
        wrap.title = '点击查看大图';
        wrap.innerHTML = svgMarkup;
        wrap.addEventListener('click', () => {
            fullscreen = { svg: wrap.innerHTML, zoom: 1, x: 0, y: 0 };
        });
        return wrap;
    }

    async function rerenderOnTheme(): Promise<void> {
        const root = container;
        if (!root) return;
        const inlines = Array.from(root.querySelectorAll<HTMLElement>('.rr-mermaid-inline'));
        if (inlines.length === 0) return;
        const mermaid = await loadMermaid();
        for (const el of inlines) {
            const raw = decodeURIComponent(el.dataset.rrRaw ?? '');
            if (!raw) continue;
            try {
                const id = 'mmd-' + Math.random().toString(36).slice(2, 9);
                const { svg } = await mermaid.render(id, raw);
                el.innerHTML = svg;
            } catch (e) {
                console.warn('[mermaid] rerender failed', e);
            }
        }
    }

    function fsZoom(delta: number): void {
        if (!fullscreen) return;
        fullscreen.zoom = nextZoom(fullscreen.zoom, delta);
    }

    function fsReset(): void {
        if (!fullscreen) return;
        fullscreen.zoom = 1;
        fullscreen.x = 0;
        fullscreen.y = 0;
    }

    function fsToggleBrowserFullscreen(): void {
        // 用 class 驱动视觉全屏（跨平台，iOS 无 Fullscreen API 也生效）；
        // 同时尝试 requestFullscreen 让桌面/Android 隐藏浏览器 UI
        browserFs = !browserFs;
        const el = document.querySelector('.rr-mermaid-overlay');
        if (browserFs) {
            el?.requestFullscreen?.().catch(() => {
                // 不支持（iOS 等）：browserFs 已 true，靠 CSS class 模拟全屏布局
            });
        } else if (document.fullscreenElement) {
            document.exitFullscreen?.().catch(() => {});
        }
    }

    function onKey(e: KeyboardEvent): void {
        if (e.key === 'Escape' && fullscreen) fullscreen = null;
    }

    // 浏览器退出全屏（Esc）时同步 class 状态
    function onFsChange(): void {
        browserFs = !!document.fullscreenElement;
    }

    // lightbox 打开时聚焦 overlay、关闭时焦点回触发元素
    function focusOnMount(node: HTMLElement) {
        const prev = document.activeElement as HTMLElement | null;
        node.focus();
        return {
            destroy() {
                if (prev && typeof prev.focus === 'function') prev.focus();
            }
        };
    }

    // Pointer Events 统一鼠标/触摸/笔：单指拖动平移、双指 pinch 缩放、滚轮缩放
    function gestures(node: HTMLElement) {
        let pointers = new Map<number, { x: number; y: number }>();
        let pinchStartDist = 0;
        let zoomStart = 1;
        let dragStart = { x: 0, y: 0 };
        let panStart = { x: 0, y: 0 };
        let dragging = false;

        const onPointerDown = (e: PointerEvent) => {
            if (!fullscreen) return;
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pointers.size === 1) {
                dragging = true;
                dragStart = { x: e.clientX, y: e.clientY };
                panStart = { x: fullscreen.x, y: fullscreen.y };
            } else if (pointers.size === 2) {
                dragging = false;
                const pts = [...pointers.values()];
                pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                zoomStart = fullscreen.zoom;
            }
            try {
                node.setPointerCapture(e.pointerId);
            } catch (e) {
                // 忽略 capture 失败
            }
        };
        const onPointerMove = (e: PointerEvent) => {
            if (!fullscreen) return;
            if (pointers.has(e.pointerId)) {
                pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
            }
            if (pointers.size >= 2 && pinchStartDist > 0) {
                const pts = [...pointers.values()];
                const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
                fullscreen.zoom = clampZoom(zoomStart * (d / pinchStartDist));
            } else if (dragging) {
                fullscreen.x = panStart.x + (e.clientX - dragStart.x);
                fullscreen.y = panStart.y + (e.clientY - dragStart.y);
            }
        };
        const onPointerUp = (e: PointerEvent) => {
            pointers.delete(e.pointerId);
            if (pointers.size < 2) pinchStartDist = 0;
            if (pointers.size === 0) dragging = false;
        };
        const onWheel = (e: WheelEvent) => {
            if (!fullscreen) return;
            e.preventDefault();
            fullscreen.zoom = clampZoom(fullscreen.zoom - e.deltaY * 0.0015);
        };

        node.addEventListener('pointerdown', onPointerDown);
        node.addEventListener('pointermove', onPointerMove);
        node.addEventListener('pointerup', onPointerUp);
        node.addEventListener('pointercancel', onPointerUp);
        node.addEventListener('wheel', onWheel, { passive: false });
        cleanups.push(() => {
            node.removeEventListener('pointerdown', onPointerDown);
            node.removeEventListener('pointermove', onPointerMove);
            node.removeEventListener('pointerup', onPointerUp);
            node.removeEventListener('pointercancel', onPointerUp);
            node.removeEventListener('wheel', onWheel);
        });
        return {};
    }

    onMount(() => {
        themeObserver = new MutationObserver(() => {
            void rerenderOnTheme();
        });
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
        window.addEventListener('keydown', onKey);
        document.addEventListener('fullscreenchange', onFsChange);
        return () => {
            themeObserver?.disconnect();
            window.removeEventListener('keydown', onKey);
            document.removeEventListener('fullscreenchange', onFsChange);
            cleanups.forEach((fn) => fn());
            cleanups = [];
        };
    });
</script>

{#if fullscreen}
    <div
        class="rr-mermaid-overlay"
        class:rr-fs={browserFs}
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        use:focusOnMount
        onclick={(e) => {
            if (e.target === e.currentTarget) fullscreen = null;
        }}
        onkeydown={(e) => {
            if (e.key === 'Escape' || e.key === 'Enter') fullscreen = null;
        }}
    >
        <div class="rr-mermaid-overlay-inner">
            <div class="rr-mermaid-bar">
                <span class="rr-mermaid-label">图表 · {formatZoom(fullscreen.zoom)}</span>
                <div class="rr-mermaid-ctrls">
                    <button type="button" class="rr-mermaid-btn" onclick={() => fsZoom(-ZOOM_STEP)} title="缩小">−</button>
                    <button type="button" class="rr-mermaid-btn" onclick={() => fsReset()} title="重置 100%">⊙</button>
                    <button type="button" class="rr-mermaid-btn" onclick={() => fsZoom(ZOOM_STEP)} title="放大">+</button>
                    <button type="button" class="rr-mermaid-btn" onclick={() => fsToggleBrowserFullscreen()} title="全屏">⛶</button>
                    <button
                        type="button"
                        class="rr-mermaid-btn"
                        onclick={() => {
                            fullscreen = null;
                        }}
                        title="关闭"
                    >✕</button>
                </div>
            </div>
            <div class="rr-mermaid-stage" use:gestures>
                <div
                    class="rr-mermaid-svg-wrap"
                    style={`transform: translate(${fullscreen.x}px, ${fullscreen.y}px) scale(${fullscreen.zoom})`}
                >
                    {@html fullscreen.svg}
                </div>
            </div>
        </div>
    </div>
{/if}

<style>
    :global(.rr-mermaid-inline) {
        text-align: center;
        margin: 1rem 0;
        cursor: zoom-in;
    }
    :global(.rr-mermaid-inline svg) {
        max-width: 100%;
        height: auto;
    }
    :global(.rr-mermaid-fallback) {
        padding: 1rem;
        overflow-x: auto;
        background: var(--rr-code-bg, #1e2228);
        color: #e1e4e8;
        border-radius: 8px;
        margin: 1rem 0;
        font-family: ui-monospace, Menlo, monospace;
    }

    .rr-mermaid-overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(0, 0, 0, 0.8);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
    }
    .rr-mermaid-overlay-inner {
        background: var(--rr-card-bg, #fff);
        border: 1px solid var(--rr-border, #d0d7de);
        border-radius: 12px;
        max-width: 95vw;
        max-height: 92vh;
        overflow: hidden;
        display: flex;
        flex-direction: column;
        width: 100%;
    }
    .rr-mermaid-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        border-bottom: 1px solid var(--rr-border-soft, #eaecef);
        background: var(--rr-bg, #f6f8fa);
        flex-shrink: 0;
    }
    .rr-mermaid-label {
        font-size: 12px;
        color: var(--rr-text-muted, #57606a);
    }
    .rr-mermaid-ctrls {
        display: flex;
        gap: 4px;
    }
    .rr-mermaid-btn {
        min-width: 28px;
        height: 28px;
        padding: 0 6px;
        border: 1px solid var(--rr-border, #d0d7de);
        border-radius: 5px;
        background: var(--rr-card-bg, #fff);
        color: var(--rr-text-muted, #57606a);
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
    }
    .rr-mermaid-btn:hover {
        color: var(--rr-text, #1f2328);
    }
    .rr-mermaid-stage {
        flex: 1;
        overflow: hidden;
        position: relative;
        touch-action: none;
        cursor: grab;
    }
    .rr-mermaid-stage:active {
        cursor: grabbing;
    }
    .rr-mermaid-svg-wrap {
        transform-origin: center center;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .rr-mermaid-svg-wrap :global(svg) {
        max-width: 100%;
        max-height: 80vh;
        height: auto;
    }

    /* 全屏（⛶）：去标题栏、控件浮右上角、图表占满视口。
       class 驱动（.rr-fs）跨平台，:fullscreen 兜底桌面/Android 浏览器全屏。 */
    .rr-mermaid-overlay.rr-fs {
        background: var(--rr-bg, #f6f8fa);
        padding: 0;
        align-items: stretch;
        justify-content: stretch;
    }
    .rr-mermaid-overlay.rr-fs .rr-mermaid-overlay-inner {
        max-width: none;
        max-height: none;
        border: none;
        border-radius: 0;
    }
    .rr-mermaid-overlay.rr-fs .rr-mermaid-bar {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 10;
        background: transparent;
        border: none;
        padding: 0;
    }
    .rr-mermaid-overlay.rr-fs .rr-mermaid-label {
        display: none;
    }
    .rr-mermaid-overlay.rr-fs .rr-mermaid-svg-wrap :global(svg) {
        max-height: 100vh;
    }
    :global(.rr-mermaid-overlay.rr-fs) {
        background: var(--rr-bg, #f6f8fa);
        padding: 0;
    }
    :global(.rr-mermaid-overlay:fullscreen) {
        background: var(--rr-bg, #f6f8fa);
        padding: 0;
    }
    :global(.rr-mermaid-overlay:fullscreen .rr-mermaid-overlay-inner) {
        max-width: none;
        max-height: none;
        border: none;
        border-radius: 0;
    }
    :global(.rr-mermaid-overlay:fullscreen .rr-mermaid-bar) {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 10;
        background: transparent;
        border: none;
        padding: 0;
    }
    :global(.rr-mermaid-overlay:fullscreen .rr-mermaid-label) {
        display: none;
    }
</style>
