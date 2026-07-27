<script lang="ts">
    import { onMount } from 'svelte';
    import { nextZoom, formatZoom, ZOOM_STEP } from '$lib/shared/mermaid-zoom';

    let { container, html }: { container: HTMLDivElement | undefined; html: string } = $props();

    let fullscreen = $state<{ svg: string; zoom: number } | null>(null);
    let themeObserver: MutationObserver | null = null;
    let cleanups: Array<() => void> = [];

    function currentTheme(): 'light' | 'dark' {
        return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    }

    async function loadMermaid() {
        const m = (await import('mermaid')).default;
        // securityLevel:'strict' 是 mermaid 11 默认值，此处显式声明：
        // 防御深度——与 markdown-it html:false、CSP 同属多层防线，防止未来误改为 loose
        // 致下方 canvas.innerHTML / {@html} 的 SVG 注入变成 XSS 面。
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
                pre.replaceWith(buildCard(svg, raw));
            } catch (e) {
                console.warn('[mermaid] render failed', e);
                const fb = document.createElement('pre');
                fb.className = 'rr-mermaid-fallback';
                fb.textContent = raw;
                pre.replaceWith(fb);
            }
        }
    }

    function buildCard(svgMarkup: string, raw: string): HTMLElement {
        const card = document.createElement('div');
        card.className = 'rr-mermaid-card';
        card.dataset.rrRaw = encodeURIComponent(raw);

        const bar = document.createElement('div');
        bar.className = 'rr-mermaid-bar';
        const label = document.createElement('span');
        label.className = 'rr-mermaid-label';
        label.textContent = '图表';
        const ctrls = document.createElement('div');
        ctrls.className = 'rr-mermaid-ctrls';

        const canvas = document.createElement('div');
        canvas.className = 'rr-mermaid-canvas';
        canvas.innerHTML = svgMarkup;

        let zoom = 1;
        const pct = document.createElement('span');
        pct.className = 'rr-mermaid-pct';
        pct.title = '双击重置为 100%';
        const apply = (z: number): void => {
            zoom = z;
            pct.textContent = formatZoom(zoom);
            canvas.style.setProperty('zoom', String(zoom));
            canvas.style.cursor = zoom > 1 ? 'grab' : 'default';
        };
        apply(1);
        pct.addEventListener('dblclick', () => apply(1));

        const minus = mkBtn('−', '缩小', () => apply(nextZoom(zoom, -ZOOM_STEP)));
        const plus = mkBtn('+', '放大', () => apply(nextZoom(zoom, ZOOM_STEP)));
        const full = mkBtn('⤢', '全屏查看', () => {
            fullscreen = { svg: svgMarkup, zoom: 1 };
        });

        ctrls.append(minus, pct, plus, full);
        bar.append(label, ctrls);
        card.append(bar, canvas);
        enableDrag(canvas);
        return card;
    }

    function mkBtn(text: string, title: string, onClick: () => void): HTMLButtonElement {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'rr-mermaid-btn';
        b.textContent = text;
        b.title = title;
        b.addEventListener('click', onClick);
        return b;
    }

    function enableDrag(canvas: HTMLElement): void {
        let down = false;
        let sx = 0;
        let sy = 0;
        let sl = 0;
        let st = 0;
        const onDown = (e: MouseEvent) => {
            const overflowX = canvas.scrollWidth > canvas.clientWidth;
            const overflowY = canvas.scrollHeight > canvas.clientHeight;
            if (!overflowX && !overflowY) return;
            down = true;
            sx = e.pageX;
            sy = e.pageY;
            sl = canvas.scrollLeft;
            st = canvas.scrollTop;
            canvas.classList.add('dragging');
            e.preventDefault();
        };
        const onMove = (e: MouseEvent): void => {
            if (!down) return;
            canvas.scrollLeft = sl - (e.pageX - sx);
            canvas.scrollTop = st - (e.pageY - sy);
        };
        const onUp = (): void => {
            if (!down) return;
            down = false;
            canvas.classList.remove('dragging');
        };
        canvas.addEventListener('mousedown', onDown);
        window.addEventListener('mousemove', onMove);
        window.addEventListener('mouseup', onUp);
        // 注册清理：组件销毁时统一 removeEventListener，防 window 监听器累积泄漏
        cleanups.push(() => {
            canvas.removeEventListener('mousedown', onDown);
            window.removeEventListener('mousemove', onMove);
            window.removeEventListener('mouseup', onUp);
        });
    }

    async function rerenderOnTheme(): Promise<void> {
        const root = container;
        if (!root) return;
        const cards = Array.from(root.querySelectorAll<HTMLElement>('.rr-mermaid-card'));
        if (cards.length === 0) return;
        const mermaid = await loadMermaid();
        for (const card of cards) {
            const raw = decodeURIComponent(card.dataset.rrRaw ?? '');
            if (!raw) continue;
            try {
                const id = 'mmd-' + Math.random().toString(36).slice(2, 9);
                const { svg } = await mermaid.render(id, raw);
                const cv = card.querySelector<HTMLElement>('.rr-mermaid-canvas');
                if (cv) cv.innerHTML = svg;
            } catch (e) {
                console.warn('[mermaid] rerender failed', e);
            }
        }
    }

    function onKey(e: KeyboardEvent): void {
        if (e.key === 'Escape') fullscreen = null;
    }

    function fsZoom(delta: number): void {
        if (!fullscreen) return;
        fullscreen.zoom = nextZoom(fullscreen.zoom, delta);
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
        return () => {
            themeObserver?.disconnect();
            window.removeEventListener('keydown', onKey);
            cleanups.forEach((fn) => fn());
            cleanups = [];
        };
    });

    function focusOnMount(node: HTMLElement) {
        const prev = document.activeElement as HTMLElement | null;
        node.focus();
        return {
            destroy() {
                if (prev && typeof prev.focus === 'function') prev.focus();
            }
        };
    }
</script>

{#if fullscreen}
    <div
        class="rr-mermaid-overlay"
        role="dialog"
        aria-modal="true"
        tabindex="-1"
        use:focusOnMount
        onclick={() => {
            fullscreen = null;
        }}
        onkeydown={(e) => {
            if (e.key === 'Escape' || e.key === 'Enter') fullscreen = null;
        }}
    >
        <div
            class="rr-mermaid-overlay-inner"
            role="presentation"
            onclick={(e) => e.stopPropagation()}
            onkeydown={(e) => e.stopPropagation()}
        >
            <div class="rr-mermaid-bar">
                <span class="rr-mermaid-label">图表 · 全屏</span>
                <div class="rr-mermaid-ctrls">
                    <button type="button" class="rr-mermaid-btn" onclick={() => fsZoom(-ZOOM_STEP)}>−</button>
                    <span class="rr-mermaid-pct">{formatZoom(fullscreen.zoom)}</span>
                    <button type="button" class="rr-mermaid-btn" onclick={() => fsZoom(ZOOM_STEP)}>+</button>
                    <button
                        type="button"
                        class="rr-mermaid-btn"
                        title="关闭"
                        onclick={() => {
                            fullscreen = null;
                        }}
                    >✕</button>
                </div>
            </div>
            <div class="rr-mermaid-canvas is-fullscreen" style={`zoom:${fullscreen.zoom}`}>
                {@html fullscreen.svg}
            </div>
        </div>
    </div>
{/if}

<style>
    :global(.rr-mermaid-card) {
        border: 1px solid var(--rr-border, #d0d7de);
        border-radius: 10px;
        background: var(--rr-card-bg, #fff);
        box-shadow: var(--rr-shadow, 0 1px 3px rgba(0,0,0,.05), 0 10px 28px rgba(0,0,0,.06));
        margin: 1rem 0;
        overflow: hidden;
    }
    :global(.rr-mermaid-bar) {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        border-bottom: 1px solid var(--rr-border-soft, #eaecef);
        background: var(--rr-bg, #f6f8fa);
    }
    :global(.rr-mermaid-label) {
        font-size: 12px;
        color: var(--rr-text-muted, #57606a);
        font-weight: 600;
    }
    :global(.rr-mermaid-ctrls) {
        display: flex;
        gap: 4px;
        align-items: center;
    }
    :global(.rr-mermaid-btn) {
        min-width: 26px;
        height: 26px;
        padding: 0 6px;
        border: 1px solid var(--rr-border, #d0d7de);
        border-radius: 5px;
        background: var(--rr-card-bg, #fff);
        color: var(--rr-text-muted, #57606a);
        cursor: pointer;
        font-size: 13px;
        line-height: 1;
    }
    :global(.rr-mermaid-btn:hover) {
        color: var(--rr-text, #1f2328);
    }
    :global(.rr-mermaid-pct) {
        font-size: 11px;
        color: var(--rr-text-muted, #57606a);
        min-width: 40px;
        text-align: center;
        user-select: none;
        cursor: pointer;
    }
    :global(.rr-mermaid-canvas) {
        padding: 16px;
        text-align: center;
        overflow: auto;
        max-height: 420px;
        min-width: 0;
    }
    :global(.rr-mermaid-canvas.dragging) {
        cursor: grabbing !important;
    }
    :global(.rr-mermaid-canvas svg) {
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

    :global(.rr-mermaid-overlay) {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: rgba(0, 0, 0, 0.7);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 24px;
    }
    :global(.rr-mermaid-overlay-inner) {
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
    :global(.rr-mermaid-canvas.is-fullscreen) {
        overflow: auto;
        max-height: none;
        flex: 1;
        padding: 20px;
    }
</style>
