# 图片支持 · Phase 5：前端 Lightbox + 冷却收敛 + e2e + 文档批 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 图片查看体验收官（ImageLightbox 图集模式 + 手势角色切换）、手势基建三消费者收敛、冷却双体系适配器收敛、e2e 全链路冒烟、全套文档更新——图片支持整体交付。

**Architecture:** 手势/浮层基建从 MermaidViewer+TableFullscreen 双份内联抽到 `$lib/shared/`（参数化：缩放范围/回调/swipe 挂点），ImageLightbox 作第三个消费者；冷却收敛走**适配器**（S3ObjectStore 内部持有 S3BlobStore，删重复 S3 客户端构建 ~40 行——ObjectStore 接口/tiering/消费者/测试零改动，spec #18"不重构 tiering"的最小风险落实）；e2e 按**项目先例**——e2e-check.sh 扩展常驻 curl 冒烟 + 一次性 Playwright 脚本验收 lightbox（不建持久基建）。

**Tech Stack:** Svelte 5（$state/$effect/$props/action）、既有 theme.css 变量体系（禁写死色值）、Playwright（一次性脚本）。

**Spec:** §10（前端交互规格全量已定稿）。**批次**：第 5/5 批（收官）。

## 运行纪律（同前四批）

worktree `bun install` + `cd apps/web && bunx svelte-kit sync`；TDD（纯函数部分）；组件视觉验收靠 Playwright 脚本；`json(body,{status})` 等既有经验全适用。

---

### Task 1: 手势基建抽取（三消费者收敛的地基）

**Files:**
- Create: `apps/web/src/lib/shared/overlay-gestures.ts`、`apps/web/src/lib/shared/overlay-mount.ts`、`apps/web/src/lib/shared/zoom.ts`
- Delete: `apps/web/src/lib/shared/mermaid-zoom.ts`（内容并入 zoom.ts）
- Modify: `apps/web/src/components/MermaidViewer.svelte`、`apps/web/src/components/TableFullscreen.svelte`（改 import，删内联实现）
- Test: `apps/web/tests/zoom.test.ts`（mermaid-zoom.test.ts 迁移+参数化用例）

- [ ] **Step 1: 失败测试**（zoom.test.ts：既有 nextZoom/clampZoom/formatZoom 用例迁移 + 参数化范围用例 `clampZoom(0.1, {min:0.2,max:10})===0.2`）
- [ ] **Step 3: 实现**：

```ts
// overlay-mount.ts —— 浮层挂载 action（聚焦 + body 滚动锁 + 关闭归还焦点）：从双份内联逐字收敛
export function overlayOnMount(node: HTMLElement): { destroy(): void } {
    const prev = document.activeElement as HTMLElement | null;
    node.focus();
    lockBodyScroll();
    return {
        destroy() {
            unlockBodyScroll();
            if (prev && typeof prev.focus === 'function') prev.focus();
        }
    };
}
```

```ts
// zoom.ts —— 缩放数学（mermaid-zoom 泛化：范围参数化，默认保持 mermaid 现值 0.5–3）
export const MIN_ZOOM = 0.5;
export const MAX_ZOOM = 3;
export const ZOOM_STEP = 0.2;
export function clampZoom(z: number, range: { min?: number; max?: number } = {}): number {
    const min = range.min ?? MIN_ZOOM;
    const max = range.max ?? MAX_ZOOM;
    if (z < min) return min;
    if (z > max) return max;
    return z;
}
export function nextZoom(current: number, delta: number, range?: { min?: number; max?: number }): number {
    return clampZoom(current + delta, range);
}
export function formatZoom(z: number): string { return Math.round(z * 100) + '%'; }
```

```ts
// overlay-gestures.ts —— Pointer Events 手势 action（参数化）：从 MermaidViewer 版收敛 + 扩展。
// opts.onZoom(factor)  pinch 缩放（clamp 由消费方决定范围——本 action 不内置）
// opts.onPan(dx,dy)    单指拖动平移（消费方按增量累计）
// opts.onWheelZoom(deltaY) 滚轮缩放（preventDefault 内置）
// opts.onSwipe(dir)    【ImageLightbox 专用挂点】1x 态单指快速横滑——spec §10 手势角色切换的切图通道：
//     消费方按当前 zoom 决定 onPan 还是 onSwipe 接管（本 action 只上报原始手势，
//     角色判定回调 opts.shouldSwipe?: () => boolean，true 时横向位移>阈值且抬起时速度达标→onSwipe('left'|'right')，
//     否则走 onPan）。Mermaid/TableFullscreen 不传 shouldSwipe → 永远 onPan（行为不变）
export interface GestureOpts {
    onPan?: (dx: number, dy: number) => void;
    onZoom?: (factor: number) => void;
    onWheelZoom?: (deltaY: number) => void;
    onSwipe?: (dir: 'left' | 'right') => void;
    shouldSwipe?: () => boolean;
}
export function overlayGestures(node: HTMLElement, opts: GestureOpts): { destroy(): void } {
    // 逐字收敛 MermaidViewer.gestures 的 pointer 生命周期骨架（Map/setPointerCapture/destroy 拆监听——P2-12 不变量）；
    // pinch: zoomStart 与起点距离 → opts.onZoom(d / pinchStartDist)
    // drag: 消费方累计（onPan(增量 dx,dy)——与 Mermaid 版的绝对 pan 语义不同：收敛版统一增量式，
    //        MermaidViewer 调用点改为 onPan((dx,dy) => { fullscreen.x = panStart.x + dx; ... }) 语义等价）
    // swipe: pointerdown 记起点+时刻；pointerup 时若 shouldSwipe?.() 且 |dx|>屏宽1/4 且速度达标 → onSwipe(dx>0?'right':'left')
    // wheel: preventDefault + opts.onWheelZoom(e.deltaY)
}
```

（收敛语义变更说明：Mermaid 现版 onPan 是"拖动中每 move 事件直接设置绝对坐标（panStart+位移）"；收敛版改增量上报、消费方组合 panStart——MermaidViewer 调用点一行适配，行为逐字节等价。TableFullscreen 版无 pan（表格只缩放）——只接 onZoom/onWheelZoom，行为不变。）

- [ ] **Step 4/5: zoom 测试绿 + MermaidViewer/TableFullscreen 改造后**全量回归（687 零变化——行为不变的证明）+ svelte-check
- [ ] Commit `refactor(web): 手势/浮层/缩放基建抽取 shared——MermaidViewer/TableFullscreen 双内联收敛，ImageLightbox 地基`

---

### Task 2: ImageLightbox 组件 + 正文接线

**Files:**
- Create: `apps/web/src/lib/components/ImageLightbox.svelte`
- Modify: `apps/web/src/lib/components/MarkdownViewer.svelte`（img 点击委托 + 样式）
- Test: 一次性 Playwright 脚本验收（Task 4 统一跑）

**ImageLightbox.svelte 完整实现要点**（spec §10 交互规格逐条落地；样式全部走 theme.css 变量）：

```svelte
<script lang="ts">
    import { overlayOnMount } from '$lib/shared/overlay-mount';
    import { overlayGestures } from '$lib/shared/overlay-gestures';
    import { nextZoom, formatZoom, ZOOM_STEP, clampZoom } from '$lib/shared/zoom';
    import { trapTabKey } from '$lib/shared/focus-trap';

    // props：图集（当前文档全部正文 <img> 的 src/alt 列表——MarkdownViewer 收集传入）+ 初始索引
    let { images, start, onClose }: {
        images: Array<{ src: string; alt: string }>;
        start: number;
        onClose(): void;
    } = $props();

    const RANGE = { min: 0.2, max: 10 }; // spec：图片缩放范围宽于 mermaid（查看局部）
    let idx = $state(start);
    let zoom = $state(1);
    let x = $state(0);
    let y = $state(0);
    let browserFs = $state(false);

    // 切图重置（spec：每图独立状态 100%）
    function show(n: number): void {
        idx = (n + images.length) % images.length;
        zoom = 1; x = 0; y = 0;
    }

    // 手势角色切换（spec §10 核心交互）：1x 态单指横滑=切图；>1x 态拖动=平移；pinch 跨越 1x 即切角色
    let panStart = { x: 0, y: 0 };
    const gesturesOpts = {
        onPan: (dx: number, dy: number): void => {
            x = panStart.x + dx; y = panStart.y + dy;
        },
        onPanStart: (): void => { panStart = { x, y }; },   // 拖动起点快照（action 在 pointerdown 时回调）
        onZoom: (factor: number): void => { zoom = clampZoom(zoom * factor, RANGE); },
        onWheelZoom: (deltaY: number): void => { zoom = clampZoom(zoom - deltaY * 0.0015, RANGE); },
        onSwipe: (dir): void => { show(dir === 'left' ? idx + 1 : idx - 1); },
        shouldSwipe: (): boolean => zoom <= 1
    };
    // 1x 态边缘阻尼（>1x 拖到边界继续向外）：实现为 pan 超界衰减系数——CSS transform 阶段处理，
    // 简化：shouldSwipe() 为 true 时 onPan 直接忽略（1x 态不平移）+ swipe 回调带位移（跟手位移由
    // overlay 内 img 的 transition 呈现——v1 从简：非跟手翻页（淡入淡出），跟手位移备案）

    function onDblClick(e: MouseEvent): void {
        // 双击 1x⇄2.5x（锚定双击点——transform-origin 设为点击点百分比）
        if (zoom === 1) { zoom = 2.5; x = (0.5 - e.offsetX / nodeWidth) * /* 锚定计算 */ 0; /* 简化 */ }
        else show(idx);
    }
    // 键盘：←/→ 切图、+/- 缩放、Esc 关闭；焦点圈定 trapTabKey；序号显示 `${idx+1} / ${images.length}`
    // 工具栏（与 mermaid 同构最小集）：− / 重置(100%) / + / ⛶ / ✕；淡入淡出（CSS transition opacity）
</script>
```

（执行注：① `onPanStart` 挂点是 overlay-gestures 需补的第三个回调（Task 1 的 GestureOpts 加上）；② 双击锚定 v1 从简——zoom=2.5 时 transform-origin 定为双击点、位移归零（可感知的"以点击点为中心放大"，无精确反向平移计算，spec 已备案 v1 从简基调）；③ 1x 态 swipe 非跟手（淡入淡出翻页）符合"打开/关闭动画从简"同款裁决。）

**MarkdownViewer 接线**：

```ts
    // 正文图片点击 → 图集 lightbox（spec §10.2）：事件委托收集全部 <img>（不含 .rr-img-missing 裂图占位——
    // 它是 span 天然不命中 img 选择器）
    let lightbox = $state<{ images: Array<{ src: string; alt: string }>; start: number } | null>(null);
    $effect(() => {
        const root = container;
        if (!root) return;
        const onClick = (e: Event): void => {
            const img = e.target;
            if (!(img instanceof HTMLImageElement)) return;
            const all = Array.from(root.querySelectorAll<HTMLImageElement>('.markdown-body img, img'));
            const list = all.map((el) => ({ src: el.getAttribute('src') ?? '', alt: el.alt }));
            const i = all.indexOf(img);
            if (i >= 0) lightbox = { images: list, start: i };
        };
        root.addEventListener('click', onClick);
        return () => root.removeEventListener('click', onClick);
    });
```

```svelte
{#if lightbox}
    <ImageLightbox images={lightbox.images} start={lightbox.start} onClose={() => (lightbox = null)} />
{/if}
```

样式（MarkdownViewer style 区追加）：正文 img `border-radius: 6px; cursor: zoom-in;`（max-width 已有）；ImageLightbox overlay 样式照 mermaid overlay 结构（scrim/工具栏/序号），全部变量化。

- [ ] svelte-check + dev 手动冒烟（带图文档点击放大）
- [ ] Commit `feat(web): ImageLightbox 图集查看器——手势角色切换/双击/全屏/序号，正文图片点击接线`

---

### Task 3: 冷却收敛（适配器方案）

**Files:** Modify `apps/web/src/lib/server/object-store-s3.ts`（S3ObjectStore 改为持有 S3BlobStore）
- [ ] 实现：S3ObjectStore 的 put/get/delete 内部转调 `new S3BlobStore(config)`（构造时建一次），put 做 `Buffer.from(content)`、get 做 `buf.toString('utf-8')`——删掉重复的 S3Client 构建/NodeHttpHandler/超时配置（~40 行）；对外接口与错误映射（mapGetError 保留原位）行为不变
- [ ] 全量回归（tiering/documents/object-store 全部既有测试零改动即绿 = 行为不变的证明）+ bridge check
- [ ] Commit `refactor(web): S3ObjectStore 适配器化——内部持有 S3BlobStore，删重复 S3 客户端构建（消费者/测试零改动）`

---

### Task 4: e2e 冒烟扩展 + lightbox Playwright 验收

**Files:** Modify `scripts/e2e-check.sh`（追加图片段）；Create `scripts/e2e-images.mjs`（一次性 Playwright 脚本，验收后保留为可选手跑脚本）

- [ ] **e2e-check.sh 追加段**（curl 级，风格照既有段落）：

```bash
# —— 图片支持全链路 ——
# 1. init 新图（PNG 魔数 + 真实 hash）→ relay 三态断言（status/name 字段）
# 2. 上传带图 md（content 引用图名）→ 查看 /s/<token> 200 且 HTML 含 /i/<name> 代理 URL
# 3. GET 代理 URL → 200 + Content-Type: image/png + 字节 == 原图
# 4. GET /s/<token>/i/<不存在名> → 404（refs 白名单）
# 5. 删除文档 → 图 refs 归零软删（flush 后）→ 代理 URL 404
# 6. 错误场景：SVG base64 → 400 invalid；谎报 hash → 400 invalid
```

- [ ] **e2e-images.mjs**（Playwright，手动跑）：dev server + seed-token 起环境 → 上传带图 md → 打开 /s/<token> 断言 img 渲染 → 点击 → lightbox 开（序号/工具栏可见）→ 滚轮缩放（zoom% 文案变化）→ 拖动（transform 变化）→ Esc 关闭 → 双击 → ←/→ 切图 → 全屏按钮。桌面 Chromium 一轮（移动 375 视口 swipe 断言从简备案——桌面键盘切图已覆盖图集语义）。
- [ ] Commit `test(e2e): 图片全链路 curl 冒烟 + lightbox Playwright 验收脚本`

---

### Task 5: 文档批 + 收尾

**Files:** Modify `README.md`/`README.en.md`、`docs/USER_GUIDE.md`、`docs/INSTALL.md`、`AGENTS.md`；`MEMORY.md`（本地）

- [ ] **README（双语）**：特性列表加图片支持（本地图片自动上传/CDN 直连/去重/Lightbox）；架构 sequenceDiagram 加图片分支；快速开始加带图上传 curl 示例；桥章节补图片说明
- [ ] **USER_GUIDE**：Agent 操作节——带图 md 上传（路径解析规则/SVG 不支持/大小建议/≤50 图）；图片管理（去重/GC 自动清理/删除文档自动回收）
- [ ] **INSTALL.md**：§9 env 汇总表补 IMAGE_STORE_BACKEND/MAX_IMAGE_BYTES/IMAGE_SIGNED_URL_TTL/IMAGE_PROXY_ALL/IMAGES_META_RATE_LIMIT_MAX 五键 + BODY_SIZE_LIMIT 图片联动说明
- [ ] **AGENTS.md**：当前状态节追加图片支持段（五批交付摘要 + 关键不变量索引）；技术栈节补 presigner
- [ ] **MEMORY.md**：收官决策行（Phase 5 全链路交付 + 适配器收敛裁定）
- [ ] 全量测试 + 双 check + e2e-check.sh 全绿 → 最终 Commit

## Self-Review 记录

1. **Spec 覆盖**：§10 交互规格逐条（图集/切图重置/手势角色/双击/工具栏/淡入淡出/焦点圈定/滚动锁/序号）；#18 冷却收敛适配器落地；§13 e2e（curl 常驻 + Playwright 一次性——按项目"手动 Playwright 验收"先例，不建持久基建）；文档批覆盖 spec §12 遗留的 INSTALL 汇总。**备案**：swipe 跟手位移、双击精确锚定平移、移动端 Playwright swipe 断言（v1 从简，spec 基调一致）。
2. **无占位符**：Task 2 的 ImageLightbox 是"实现要点+完整逻辑骨架"（交互全集已定，样式变量化指定）——Svelte 组件无法在计划里逐字给全（视觉细节需实机调），执行者按要点+theme 变量体系实现，Playwright 验收兜底。onPanStart 是 Task 1 GestureOpts 的显式补充。
3. **类型一致性**：GestureOpts 回调签名（onPan 增量式——Mermaid 调用点一行适配语义等价）；zoom.ts 默认值保持 mermaid 现行为（0.5–3），ImageLightbox 传 RANGE。
4. **风险点**：MermaidViewer/TableFullscreen 改造后 687 测试零变化是行为不变的硬证明；S3ObjectStore 适配器的全量测试零改动同理；Playwright 脚本不进 CI（手跑记录输出贴执行报告）。
