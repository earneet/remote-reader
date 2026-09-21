// Pointer Events 手势 action（参数化）：MermaidViewer / TableFullscreen / ImageLightbox 三消费者共用，
// 从两份内联实现（MermaidViewer.gestures / TableFullscreen.gestures）收敛。
//
// 收敛语义（消费方组合规则）：
// ① onPan 上报"相对 pointerdown 起点的位移"（dx/dy），消费方 panStart + dx 组合绝对坐标
//    —— 与原 Mermaid 版 panStart.x + (e.clientX - dragStart.x) 同式等价；
// ② pinch 基准式：onZoom 上报 factor = 当前指距 / 起始指距（相对 pinch 起点的累计比），
//    消费方一律 zoom = clampZoom(zoomStart * factor)（onPinchStart 快照）——
//    若每 move 乘累计比会指数爆炸；
// ③ wheel 锚定：onWheelZoom 附带指针在 overlay 内坐标（px/py），滚轮锚定缩放用；
//    wheelRequiresCtrl = true 时仅 Ctrl/Meta 按下才回调 + preventDefault，
//    否则放行原生滚动（TableFullscreen 语义：表格 overlay 依赖普通滚轮滚动）。
export interface GestureOpts {
    onPanStart?: () => void;
    onPan?: (dx: number, dy: number) => void;
    onPinchStart?: () => void;
    onZoom?: (factor: number) => void;
    onWheelZoom?: (deltaY: number, px: number, py: number) => void;
    wheelRequiresCtrl?: boolean;
    onSwipe?: (dir: 'left' | 'right') => void;
    shouldSwipe?: () => boolean;
}

export function overlayGestures(node: HTMLElement, opts: GestureOpts): { destroy(): void } {
    const pointers = new Map<number, { x: number; y: number }>();
    let pinchStartDist = 0;
    let dragStart = { x: 0, y: 0 };
    let dragging = false;
    let swipeStart: { x: number; y: number; t: number } | null = null;

    const onPointerDown = (e: PointerEvent) => {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (pointers.size === 1) {
            dragging = true;
            dragStart = { x: e.clientX, y: e.clientY };
            if (opts.onSwipe) swipeStart = { x: e.clientX, y: e.clientY, t: performance.now() };
            opts.onPanStart?.();
        } else if (pointers.size === 2) {
            dragging = false;
            swipeStart = null; // 第二指落下即进入 pinch，不再是单指滑动
            const pts = [...pointers.values()];
            pinchStartDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            opts.onPinchStart?.();
        }
        try {
            node.setPointerCapture(e.pointerId);
        } catch {
            // 忽略 capture 失败
        }
    };

    const onPointerMove = (e: PointerEvent) => {
        if (pointers.has(e.pointerId)) {
            pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        }
        if (pointers.size >= 2 && pinchStartDist > 0) {
            const pts = [...pointers.values()];
            const d = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
            opts.onZoom?.(d / pinchStartDist);
        } else if (dragging) {
            opts.onPan?.(e.clientX - dragStart.x, e.clientY - dragStart.y);
        }
    };

    const removePointer = (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        try {
            node.releasePointerCapture(e.pointerId);
        } catch {
            // 指针已不活跃时 release 抛 NotFoundError——忽略
        }
        if (pointers.size < 2) pinchStartDist = 0;
        if (pointers.size === 0) dragging = false;
    };

    const onPointerUp = (e: PointerEvent) => {
        removePointer(e);
        // swipe（ImageLightbox 专用；Mermaid/TableFullscreen 不传 onSwipe → 永远 onPan，行为不变）。
        // OR 阈值：位移 > 1/4 视口宽，或平均速度 ≥ 0.5px/ms；位移向右 = 看上一张
        if (swipeStart && pointers.size === 0 && opts.onSwipe && (!opts.shouldSwipe || opts.shouldSwipe())) {
            const dx = e.clientX - swipeStart.x;
            const dt = performance.now() - swipeStart.t;
            const velocity = dt > 0 ? Math.abs(dx) / dt : 0;
            if (Math.abs(dx) > window.innerWidth / 4 || velocity >= 0.5) {
                opts.onSwipe(dx > 0 ? 'right' : 'left');
            }
        }
        swipeStart = null;
    };

    const onPointerCancel = (e: PointerEvent) => {
        removePointer(e);
        swipeStart = null; // 手势被系统接管（cancel）不判定为滑动
    };

    const onWheel = (e: WheelEvent) => {
        if (!opts.onWheelZoom) return;
        if (opts.wheelRequiresCtrl && !(e.ctrlKey || e.metaKey)) return; // 放行原生滚动
        e.preventDefault();
        const rect = node.getBoundingClientRect();
        opts.onWheelZoom(e.deltaY, e.clientX - rect.left, e.clientY - rect.top);
    };

    node.addEventListener('pointerdown', onPointerDown);
    node.addEventListener('pointermove', onPointerMove);
    node.addEventListener('pointerup', onPointerUp);
    node.addEventListener('pointercancel', onPointerCancel);
    node.addEventListener('wheel', onWheel, { passive: false });
    // use:overlayGestures 在 {#if} 内，浮层每次开关都会重跑 action——
    // 必须返回 destroy 逐次拆监听，否则 detached DOM 与处理器随开关累积（P2-12 不变量）
    return {
        destroy() {
            node.removeEventListener('pointerdown', onPointerDown);
            node.removeEventListener('pointermove', onPointerMove);
            node.removeEventListener('pointerup', onPointerUp);
            node.removeEventListener('pointercancel', onPointerCancel);
            node.removeEventListener('wheel', onWheel);
        }
    };
}
