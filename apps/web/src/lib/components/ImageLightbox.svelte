<script lang="ts">
    import { overlayOnMount } from '$lib/shared/overlay-mount';
    import { overlayGestures } from '$lib/shared/overlay-gestures';
    import type { GestureOpts } from '$lib/shared/overlay-gestures';
    import { nextZoom, formatZoom, ZOOM_STEP, clampZoom, ZOOM_WHEEL_FACTOR } from '$lib/shared/zoom';
    import { trapTabKey } from '$lib/shared/focus-trap';
    import { browserFullscreen, type BrowserFullscreenCtl } from '$lib/shared/browser-fullscreen';

    // props：图集（当前文档全部正文 <img> 的 src/alt 列表——MarkdownViewer 收集传入）+ 初始索引
    let { images, start, onClose }: {
        images: Array<{ src: string; alt: string }>;
        start: number;
        onClose(): void;
    } = $props();

    const RANGE = { min: 0.2, max: 10 }; // spec：图片缩放范围宽于 mermaid（查看局部）
    // svelte-ignore state_referenced_locally
    let idx = $state(start); // 初始索引快照（组件随每次打开重建，同 InlineNameForm 先例）
    let zoom = $state(1);
    let x = $state(0);
    let y = $state(0);
    // 挂载时由 use:browserFullscreen 装入实现（组件侧零全屏状态）
    let fsCtl: BrowserFullscreenCtl = { toggle: () => {}, exit: () => {} };
    let stageEl: HTMLDivElement | undefined = $state(undefined);
    // 双击锚定 v1 从简：transform-origin 定双击点 + 位移归零（可感知的中心放大，非精确反向平移）；
    // null = 中心。任何其他缩放路径先 normalizeOrigin 归一回中心（纯表示变换，视觉不动）
    let origin = $state<{ x: number; y: number } | null>(null);
    // 加载指示（spec §10）：图集切换时 loading=true，img onload/onerror 置 false——
    // 大图冷加载不再空白；imgLoaded 驱动淡入（加载完成才 opacity 1）
    let loading = $state(true);
    let imgLoaded = $state(false);

    // 切图重置（spec：每图独立状态 100%）
    function show(n: number): void {
        idx = (n + images.length) % images.length;
        zoom = 1;
        x = 0;
        y = 0;
        origin = null;
        loading = true;
        imgLoaded = false;
    }

    // 将 transform-origin 归一到中心（表示变换，视觉不变）：origin != null 时
    // t' = t + (1 - zoom) * (origin - center)
    function normalizeOrigin(): void {
        if (!origin) return;
        const el = stageEl;
        if (el) {
            const cx = el.clientWidth / 2;
            const cy = el.clientHeight / 2;
            x += (1 - zoom) * (origin.x - cx);
            y += (1 - zoom) * (origin.y - cy);
        }
        origin = null;
    }

    function zoomBy(delta: number): void {
        normalizeOrigin();
        zoom = nextZoom(zoom, delta, RANGE);
    }

    function resetView(): void {
        zoom = 1;
        x = 0;
        y = 0;
        origin = null;
    }

    // 手势角色切换（spec §10 核心交互）：1x 态单指横滑=切图；>1x 态拖动=平移；pinch 跨越 1x 即切角色
    let panStart = { x: 0, y: 0 };
    let pinchZoomStart = 1;
    const gesturesOpts: GestureOpts = {
        onPanStart: (): void => {
            panStart = { x, y };
        },
        onPan: (dx: number, dy: number): void => {
            if (zoom <= 1) return; // 1x 态不平移（swipe 接管；同款角色判定）
            x = panStart.x + dx;
            y = panStart.y + dy;
        },
        onPinchStart: (): void => {
            normalizeOrigin();
            pinchZoomStart = zoom;
        },
        onZoom: (factor: number): void => {
            zoom = clampZoom(pinchZoomStart * factor, RANGE);
        },
        onWheelZoom: (deltaY: number, px: number, py: number): void => {
            // 滚轮锚定指针（spec §10）：zoom 变化时按指针位置补偿平移，保持指针下的内容点不动。
            // 数学（transform: translate(x,y) scale(z)，origin=中心 C）：
            //   内容点 c = (P - pan - C) / prevZoom 不变 → pan' = P - c * zoom' - C
            normalizeOrigin();
            const prev = zoom;
            const next = clampZoom(zoom - deltaY * ZOOM_WHEEL_FACTOR, RANGE);
            if (next === prev) return;
            const el = stageEl;
            if (!el) {
                zoom = next;
                return;
            }
            const cx = el.clientWidth / 2;
            const cy = el.clientHeight / 2;
            const cX = (px - x - cx) / prev;
            const cY = (py - y - cy) / prev;
            zoom = next;
            x = px - cX * next - cx;
            y = py - cY * next - cy;
        },
        onSwipe: (dir: 'left' | 'right'): void => {
            show(dir === 'left' ? idx + 1 : idx - 1);
        },
        shouldSwipe: (): boolean => zoom <= 1
    };
    // swipe v1 非跟手（淡入淡出翻页）；>1x 超界平移无阻尼（同 mermaid 现版无边界行为）——
    // 两处为对 spec §10 的显式从简偏离（spec 修订口径）

    function onDblClick(e: MouseEvent): void {
        if (zoom === 1) {
            const el = stageEl;
            if (!el) return;
            const rect = el.getBoundingClientRect();
            zoom = 2.5;
            x = 0;
            y = 0;
            origin = { x: e.clientX - rect.left, y: e.clientY - rect.top };
        } else {
            show(idx);
        }
    }

    function onImgSettled(): void {
        imgLoaded = true;
        loading = false;
    }

    function close(): void {
        fsCtl.exit();
        onClose();
    }

    function handleKey(e: KeyboardEvent): boolean {
        if (e.key === 'Escape') {
            close();
            return true;
        }
        if (e.key === 'ArrowLeft') {
            show(idx - 1);
            return true;
        }
        if (e.key === 'ArrowRight') {
            show(idx + 1);
            return true;
        }
        if (e.key === '+' || e.key === '=') {
            zoomBy(ZOOM_STEP);
            return true;
        }
        if (e.key === '-') {
            zoomBy(-ZOOM_STEP);
            return true;
        }
        return false;
    }
</script>

<div
    class="rr-imglb-overlay"
    role="dialog"
    aria-modal="true"
    aria-label="图片查看器"
    tabindex="-1"
    use:overlayOnMount
    use:browserFullscreen={fsCtl}
    onkeydown={(e) => {
        if (handleKey(e)) return;
        trapTabKey(e, e.currentTarget);
    }}
>
    <div class="rr-imglb-bar">
        <span class="rr-imglb-label">图片 {idx + 1} / {images.length} · {formatZoom(zoom)}</span>
        <div class="rr-imglb-ctrls">
            <button type="button" title="缩小" onclick={() => zoomBy(-ZOOM_STEP)}>−</button>
            <button type="button" title="重置 100%" onclick={() => resetView()}>⊙</button>
            <button type="button" title="放大" onclick={() => zoomBy(ZOOM_STEP)}>+</button>
            <button type="button" title="全屏" onclick={() => fsCtl.toggle()}>⛶</button>
            <button type="button" title="关闭" onclick={() => close()}>✕</button>
        </div>
    </div>
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
        class="rr-imglb-stage"
        class:zoomed={zoom > 1}
        bind:this={stageEl}
        use:overlayGestures={gesturesOpts}
        ondblclick={onDblClick}
    >
        {#key idx}
            <div
                class="rr-imglb-wrap"
                style={`transform: translate(${x}px, ${y}px) scale(${zoom}); transform-origin: ${
                    origin ? `${origin.x}px ${origin.y}px` : 'center center'
                };`}
            >
                <img
                    class="rr-imglb-img"
                    class:loaded={imgLoaded}
                    src={images[idx].src}
                    alt={images[idx].alt}
                    draggable={false}
                    onload={onImgSettled}
                    onerror={onImgSettled}
                />
            </div>
        {/key}
        {#if loading}
            <div class="rr-imglb-spinner" aria-hidden="true"></div>
        {/if}
    </div>
</div>

<style>
    .rr-imglb-overlay {
        position: fixed;
        inset: 0;
        z-index: 1000;
        background: var(--rr-scrim-strong);
        display: flex;
        flex-direction: column;
        animation: rr-imglb-fadein 0.15s ease;
    }
    .rr-imglb-bar {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 6px 10px;
        flex-shrink: 0;
        position: relative;
        z-index: 2;
        background: var(--rr-bg);
        border-bottom: 1px solid var(--rr-border-soft);
    }
    .rr-imglb-label {
        font-size: 12px;
        color: var(--rr-text-muted);
    }
    .rr-imglb-ctrls {
        display: flex;
        gap: 4px;
    }
    .rr-imglb-ctrls button {
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
    .rr-imglb-ctrls button:hover {
        color: var(--rr-text);
    }
    .rr-imglb-stage {
        flex: 1;
        overflow: hidden;
        position: relative;
        touch-action: none;
        cursor: zoom-in;
        user-select: none;
        -webkit-user-select: none;
    }
    .rr-imglb-stage.zoomed {
        cursor: grab;
    }
    .rr-imglb-stage.zoomed:active {
        cursor: grabbing;
    }
    .rr-imglb-wrap {
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
    }
    .rr-imglb-img {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
        opacity: 0;
        transition: opacity 0.18s ease;
        -webkit-user-drag: none;
    }
    .rr-imglb-img.loaded {
        opacity: 1;
    }
    .rr-imglb-spinner {
        position: absolute;
        top: 50%;
        left: 50%;
        width: 28px;
        height: 28px;
        margin: -14px 0 0 -14px;
        border: 3px solid var(--rr-border);
        border-top-color: var(--rr-text);
        border-radius: 50%;
        animation: rr-imglb-spin 0.8s linear infinite;
    }
    /* 全屏（⛶）：去标题栏、控件浮右上角、图片占满视口（class 由 use:browserFullscreen 运行时添加 → :global，:fullscreen 兜底桌面/Android） */
    :global(.rr-imglb-overlay.rr-fs .rr-imglb-bar) {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 10;
        background: transparent;
        border: none;
        padding: 0;
    }
    :global(.rr-imglb-overlay.rr-fs .rr-imglb-label) {
        display: none;
    }
    :global(.rr-imglb-overlay:fullscreen) {
        background: var(--rr-bg);
    }
    :global(.rr-imglb-overlay:fullscreen .rr-imglb-bar) {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 10;
        background: transparent;
        border: none;
        padding: 0;
    }
    :global(.rr-imglb-overlay:fullscreen .rr-imglb-label) {
        display: none;
    }
    @keyframes rr-imglb-fadein {
        from {
            opacity: 0;
        }
        to {
            opacity: 1;
        }
    }
    @keyframes rr-imglb-spin {
        to {
            transform: rotate(360deg);
        }
    }
</style>
