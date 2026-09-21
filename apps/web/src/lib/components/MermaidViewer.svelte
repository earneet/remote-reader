<script lang="ts">
    import { onMount } from 'svelte';
    import { nextZoom, formatZoom, ZOOM_STEP, clampZoom, ZOOM_WHEEL_FACTOR } from '$lib/shared/zoom';
    import { overlayOnMount } from '$lib/shared/overlay-mount';
    import { overlayGestures } from '$lib/shared/overlay-gestures';
    import type { GestureOpts } from '$lib/shared/overlay-gestures';
    import { trapTabKey } from '$lib/shared/focus-trap';
    import { browserFullscreen, type BrowserFullscreenCtl } from '$lib/shared/browser-fullscreen';

    let { container, html }: { container: HTMLDivElement | undefined; html: string } = $props();

    let fullscreen = $state<{ svg: string; zoom: number; x: number; y: number } | null>(null);
    // 挂载时由 use:browserFullscreen 装入实现（组件侧零全屏状态）
    let fsCtl: BrowserFullscreenCtl = { toggle: () => {}, exit: () => {} };
    let themeObserver: MutationObserver | null = null;

    function currentTheme(): 'light' | 'dark' {
        return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    }

    async function loadMermaid() {
        const m = (await import('mermaid')).default;
        // securityLevel:'strict' 防御深度：与 markdown-it html:false、CSP 同属多层防线
        m.initialize({
            startOnLoad: false,
            securityLevel: 'strict',
            theme: currentTheme() === 'dark' ? 'dark' : 'default',
            // wrappingWidth 默认 200px 会把长中文节点 label 强制断行成参差不齐；放大让节点按内容宽度、尊重作者的 <br/> 换行
            flowchart: { wrappingWidth: 800 }
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

    function onKey(e: KeyboardEvent): void {
        if (e.key === 'Escape' && fullscreen) fullscreen = null;
    }

    // 手势快照（overlay-gestures 上报增量/累计比，消费方组合绝对值）：
    // onPanStart 快照 panStart → onPan(dx,dy) 里 panStart + dx；
    // onPinchStart 快照 zoomStart → onZoom(factor) 里 zoomStart * factor（基准式，防指数爆炸）
    let panStart = { x: 0, y: 0 };
    let pinchZoomStart = 1;
    const gesturesOpts: GestureOpts = {
        onPanStart: () => {
            if (!fullscreen) return;
            panStart = { x: fullscreen.x, y: fullscreen.y };
        },
        onPan: (dx, dy) => {
            if (!fullscreen) return;
            fullscreen.x = panStart.x + dx;
            fullscreen.y = panStart.y + dy;
        },
        onPinchStart: () => {
            if (!fullscreen) return;
            pinchZoomStart = fullscreen.zoom;
        },
        onZoom: (factor) => {
            if (!fullscreen) return;
            fullscreen.zoom = clampZoom(pinchZoomStart * factor);
        },
        onWheelZoom: (deltaY) => {
            if (!fullscreen) return;
            fullscreen.zoom = clampZoom(fullscreen.zoom - deltaY * ZOOM_WHEEL_FACTOR);
        }
    };

    onMount(() => {
        themeObserver = new MutationObserver(() => {
            void rerenderOnTheme();
        });
        themeObserver.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
        window.addEventListener('keydown', onKey);
        return () => {
            themeObserver?.disconnect();
            window.removeEventListener('keydown', onKey);
        };
    });
</script>

{#if fullscreen}
    <div
        class="rr-mermaid-overlay"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        use:overlayOnMount
        use:browserFullscreen={fsCtl}
        onclick={(e) => {
            if (e.target === e.currentTarget) fullscreen = null;
        }}
        onkeydown={(e) => {
            // Enter 仅在浮层自身聚焦时作为快捷关闭——不判 target 会吞掉按钮的键盘激活（P2-12）
            if ((e.key === 'Escape' || e.key === 'Enter') && e.target === e.currentTarget) fullscreen = null;
            trapTabKey(e, e.currentTarget);
        }}
    >
        <div class="rr-mermaid-overlay-inner">
            <div class="rr-mermaid-bar">
                <span class="rr-mermaid-label">图表 · {formatZoom(fullscreen.zoom)}</span>
                <div class="rr-mermaid-ctrls">
                    <button type="button" class="rr-mermaid-btn" onclick={() => fsZoom(-ZOOM_STEP)} title="缩小">−</button>
                    <button type="button" class="rr-mermaid-btn" onclick={() => fsReset()} title="重置 100%">⊙</button>
                    <button type="button" class="rr-mermaid-btn" onclick={() => fsZoom(ZOOM_STEP)} title="放大">+</button>
                    <button type="button" class="rr-mermaid-btn" onclick={() => fsCtl.toggle()} title="全屏">⛶</button>
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
            <div class="rr-mermaid-stage" use:overlayGestures={gesturesOpts}>
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
        background: var(--rr-code-bg);
        color: var(--rr-code-text);
        border-radius: 8px;
        margin: 1rem 0;
        font-family: ui-monospace, Menlo, monospace;
    }

    .rr-mermaid-overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: var(--rr-scrim-strong);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
    }
    .rr-mermaid-overlay-inner {
        background: var(--rr-card-bg);
        border: 1px solid var(--rr-border);
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
        border-bottom: 1px solid var(--rr-border-soft);
        background: var(--rr-bg);
        flex-shrink: 0;
    }
    .rr-mermaid-label {
        font-size: 12px;
        color: var(--rr-text-muted);
    }
    .rr-mermaid-ctrls {
        display: flex;
        gap: 4px;
    }
    .rr-mermaid-btn {
        min-width: 28px;
        height: 28px;
        padding: 0 6px;
        border: 1px solid var(--rr-border);
        border-radius: 5px;
        background: var(--rr-card-bg);
        color: var(--rr-text-muted);
        cursor: pointer;
        font-size: 14px;
        line-height: 1;
    }
    .rr-mermaid-btn:hover {
        color: var(--rr-text);
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
       class 由 use:browserFullscreen 运行时添加（模板静态分析不可见）→ rr-fs 选择器须 :global，
       :fullscreen 兜底桌面/Android 浏览器全屏。 */
    :global(.rr-mermaid-overlay.rr-fs) {
        background: var(--rr-bg);
        padding: 0;
        align-items: stretch;
        justify-content: stretch;
    }
    :global(.rr-mermaid-overlay.rr-fs .rr-mermaid-overlay-inner) {
        max-width: none;
        max-height: none;
        border: none;
        border-radius: 0;
    }
    :global(.rr-mermaid-overlay.rr-fs .rr-mermaid-bar) {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 10;
        background: transparent;
        border: none;
        padding: 0;
    }
    :global(.rr-mermaid-overlay.rr-fs .rr-mermaid-label) {
        display: none;
    }
    :global(.rr-mermaid-overlay.rr-fs .rr-mermaid-svg-wrap svg) {
        max-height: 100vh;
    }
    :global(.rr-mermaid-overlay:fullscreen) {
        background: var(--rr-bg);
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
