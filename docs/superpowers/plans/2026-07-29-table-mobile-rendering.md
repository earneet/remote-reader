# 表格手机端渲染修复 实现计划（v2 — 已按多 Agent 审核 32 confirmed 修正）

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development（推荐）或 superpowers:executing-plans。Steps 用 checkbox。

**Goal:** 修复 `/s/<token>`、`/d/[id]` 手机端表格被压成竖条；溢出表缩字试探、显著宽表横滑 + 全屏（选字复制友好）。桌面端除 break-word 基础修复外不动。

**Architecture:** 三层——(1) 一条 CSS `overflow-wrap:break-word` 修根因 + 自动分档；(2) 客户端 `$effect`（依赖 `html` prop）测 ratio，给溢出表加 `.rr-shrink` / `.rr-wide` + 注入全屏按钮（含 cleanup）；(3) `TableFullscreen` overlay：可滚动大画布 + scale 缩放，单指走原生滚动支持选字复制（不照搬 mermaid `touch-action:none`）。

**Tech Stack:** SvelteKit / Svelte 5 runes、TypeScript、scoped + `:global` CSS、复用 `$lib/shared/mermaid-zoom`（clampZoom/nextZoom/formatZoom）、Playwright（实现期手动，不入 CI）。

**实测基线**（spec §2，375 视口）：窄表 ratio 0.456；中表 1.0→break-word 后 1.0 不竖条；宽表 1.0→break-word 后 1.575。**C1 复核实测**：再叠 `word-break:break-word` → ratio 跌回 1.000（竖条重现），故禁用 word-break。

---

## 审核修正对照（v2 必改项已融入下述 Steps）

C1 删 word-break（Task1 S3/S6）· H1 wheel Ctrl 守卫（Task3 S4）· H2 effect 依赖 html + 清旧按钮（Task2 S1/S3）· M1 按钮 CSS 限定 wide + cleanup（Task3 S1/S2）· M2 setPointerCapture（Task3 S4）· M3 closeOverlay 重置 browserFs（Task3 S1/S3）· M4 overlay 不透明 bg（Task3 S6）· M5 按钮 sticky（Task3 S2）· M8 toggleFs 用 ref（Task3 S3/S5）· M9 复用 mermaid-zoom（Task3 S1）· M10 overlay 补 scope 样式（Task3 S6）· 加固 M6 ResizeObserver / M7 rAF（Task2 S1）/ L1 border-separate（Task3 S6）。

---

### Task 1: 核心修复 — td/th overflow-wrap + 单测

**Files:** `MarkdownViewer.svelte`（CSS）、`apps/web/tests/markdown.test.ts`

- [ ] **Step 1:** 确认 `markdown.test.ts:61-66` 已有"table 被 `.rr-table-wrap` 包裹"断言（N2：已存在，本次不新增单测，仅 CSS 改动）。
- [ ] **Step 2:** `bun run test apps/web/tests/markdown.test.ts` 通过。
- [ ] **Step 3:** `MarkdownViewer.svelte` `<style>` 紧跟现有 `td,th` 规则加（**C1：不写 word-break**）：
```css
.markdown-body :global(td),
.markdown-body :global(th) {
    overflow-wrap: break-word;
}
```
- [ ] **Step 4:** `svelte-check` 0/0。
- [ ] **Step 5:** Playwright measure（`/tmp/measure-tables.cjs` vs dev 5173）：中表（5 列）不再竖条、宽表（7 列）ratio>1。
- [ ] **Step 6:** 回归——`/tmp/table-test.md` 第 4 节长行内 code 不撑破；**C1 补**：再造一个"单元格内 80 字符长 URL/code"的表，截图确认不撑破也不竖条。
- [ ] **Step 7:** commit `fix(view): td/th overflow-wrap break-word 修手机端表格竖条`

### Task 2: 客户端测量分档（依赖 html prop + cleanup + rAF + ResizeObserver）

**Files:** 新建 `TableFullscreen.svelte`、改 `MarkdownViewer.svelte`

- [ ] **Step 1:** `TableFullscreen.svelte` 写测量 `$effect`（**H2：依赖 html；M1/M6/M7**）：
```ts
import { clampZoom } from '$lib/shared/mermaid-zoom';

let { container, html }: { container: HTMLDivElement | undefined; html: string } = $props();

$effect(() => {
    const _ = html; // H2: 依赖 html，/s/ 文档间导航 html 变化时重跑
    const root = container;
    if (!root) return;
    // H2/M1: 清上轮注入按钮（避免闭包陈旧 + DOM 残留）
    root.querySelectorAll('.rr-table-fs-btn').forEach((b) => b.remove());
    const wraps = Array.from(root.querySelectorAll<HTMLElement>('.rr-table-wrap'));
    const apply = (w: HTMLElement) => {
        const t = w.querySelector('table');
        if (!t) return;
        w.classList.remove('rr-shrink', 'rr-wide');
        const overflow = () => t.scrollWidth > w.clientWidth + 8;
        if (!overflow()) return;
        if (window.matchMedia('(max-width: 768px)').matches) {
            w.classList.add('rr-shrink');
            if (overflow()) ensureFsBtn(w, t);
        } else {
            ensureFsBtn(w, t); // 桌面：仅横滑（CSS 控制按钮 ≤768px 才显示）
        }
    };
    wraps.forEach(apply);
    let raf = 0;
    const rerun = () => { cancelAnimationFrame(raf); raf = requestAnimationFrame(() => wraps.forEach(apply)); };
    const ro = new ResizeObserver(() => rerun()); // M6: katex/字体异步加载后重测
    ro.observe(root);
    window.addEventListener('resize', rerun); // M7: rAF 节流
    return () => { cancelAnimationFrame(raf); ro.disconnect(); window.removeEventListener('resize', rerun); };
});
```
- [ ] **Step 2:** `MarkdownViewer.svelte` CSS 加：
```css
@media (max-width: 768px) {
    .markdown-body :global(.rr-table-wrap.rr-shrink) { font-size: 0.9em; }
}
```
- [ ] **Step 3:** `MarkdownViewer.svelte` 挂载（**H2：传 html**）：
```svelte
<TableFullscreen {container} {html} />
```
- [ ] **Step 4:** `svelte-check` 0/0。
- [ ] **Step 5:** Playwright 验证：375 视口中表无 class、宽表 `.rr-shrink.rr-wide`+按钮；**H2 验证**：连续打开两个含宽表 `/s/` 文档，第二个文档宽表也出现按钮（无残留旧按钮）；1200 视口宽表仅横滑无按钮（CSS hide）。
- [ ] **Step 6:** commit `feat(view): 客户端测量表格溢出分档 shrink/wide（依赖 html + cleanup）`

### Task 3: 宽表全屏 overlay（选字复制友好）

**Files:** `TableFullscreen.svelte`、`MarkdownViewer.svelte`（按钮 CSS）

- [ ] **Step 1:** state + openFullscreen/ensureFsBtn/closeOverlay（**M3/M9**）：
```ts
import { clampZoom, nextZoom, formatZoom, ZOOM_STEP } from '$lib/shared/mermaid-zoom';
let fs = $state<{ html: string } | null>(null);
let zoom = $state(1);
let browserFs = $state(false);
let overlayEl: HTMLDivElement | undefined = $state(undefined); // M8: ref 非 querySelector

function ensureFsBtn(w: HTMLElement, t: HTMLTableElement) {
    w.classList.add('rr-wide');
    if (!w.querySelector('.rr-table-fs-btn')) {
        const btn = document.createElement('button');
        btn.className = 'rr-table-fs-btn';
        btn.type = 'button';
        btn.textContent = '⛶';
        btn.title = '全屏查看表格';
        btn.addEventListener('click', () => openFullscreen(t.outerHTML));
        w.appendChild(btn);
    }
}
function openFullscreen(html: string) { fs = { html }; zoom = 1; browserFs = false; } // M3: 重置
function closeOverlay() { // M3: 集中关闭
    if (document.fullscreenElement) document.exitFullscreen()?.catch(() => {});
    browserFs = false;
    fs = null;
}
```
- [ ] **Step 2:** `MarkdownViewer.svelte` 按钮 CSS（**M1 限定 wide + M5 sticky**）：
```css
.markdown-body :global(.rr-table-fs-btn) { display: none; }
@media (max-width: 768px) {
    .markdown-body :global(.rr-table-wrap.rr-wide) { position: relative; }
    .markdown-body :global(.rr-table-wrap.rr-wide) .rr-table-fs-btn {
        display: inline-flex; align-items: center; justify-content: center;
        position: sticky; top: 4px; float: right; z-index: 2; /* M5: sticky 不随横滑滚走 */
        width: 28px; height: 28px; border-radius: 5px;
        border: 1px solid var(--rr-border, #d0d7de);
        background: var(--rr-card-bg, #fff); color: var(--rr-text-muted, #57606a);
        cursor: pointer; font-size: 14px;
    }
}
```
> 实现时验证：横滑宽表时 ⛶ 按钮仍在可视区右上角。若 sticky 失效（scroll container 内行为差异），改"按钮做成 wrap 兄弟节点、外层再裹 relative 容器"（备选方案 b）。
- [ ] **Step 3:** overlay 模板（**M8 bind:this + M3 closeOverlay**）：
```svelte
{#if fs}
<div class="rr-tbl-overlay" class:rr-fs={browserFs} bind:this={overlayEl}
    role="dialog" aria-modal="true" tabindex="-1" use:focusOnMount
    onclick={(e) => { if (e.target === e.currentTarget) closeOverlay(); }}
    onkeydown={(e) => { if (e.key === 'Escape') closeOverlay(); }}>
    <div class="rr-tbl-bar">
        <span class="rr-tbl-label">表格 · {formatZoom(zoom)}</span>
        <div class="rr-tbl-ctrls">
            <button type="button" onclick={() => (zoom = nextZoom(zoom, -ZOOM_STEP))}>−</button>
            <button type="button" onclick={() => (zoom = 1)}>⊙</button>
            <button type="button" onclick={() => (zoom = nextZoom(zoom, ZOOM_STEP))}>+</button>
            <button type="button" onclick={toggleFs} title="全屏">⛶</button>
            <button type="button" onclick={closeOverlay} title="关闭">✕</button>
        </div>
    </div>
    <div class="rr-tbl-stage" use:gestures>
        <div class="rr-tbl-scroll" style={`transform: scale(${zoom})`}>{@html fs.html}</div>
    </div>
</div>
{/if}
```
- [ ] **Step 4:** `gestures`（**H1 wheel Ctrl 守卫 + M2 capture + 单指不劫持**）：
```ts
function gestures(node: HTMLElement) {
    let pointers = new Map<number, { x: number; y: number }>();
    let pinchDist = 0;
    let zoomStart = 1;
    const down = (e: PointerEvent) => {
        pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        try { node.setPointerCapture(e.pointerId); } catch {} // M2
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
        // 单指（size<2）不动 → 交给原生滚动/选字
    };
    const up = (e: PointerEvent) => {
        pointers.delete(e.pointerId);
        try { node.releasePointerCapture(e.pointerId); } catch {} // M2
        if (pointers.size < 2) pinchDist = 0;
    };
    const wheel = (e: WheelEvent) => {
        if (!(e.ctrlKey || e.metaKey)) return; // H1: 仅 Ctrl/Meta+滚轮缩放，其余放行原生滚动
        e.preventDefault();
        zoom = clampZoom(zoom - e.deltaY * 0.0015);
    };
    node.addEventListener('pointerdown', down);
    node.addEventListener('pointermove', move);
    node.addEventListener('pointerup', up);
    node.addEventListener('pointercancel', up);
    node.addEventListener('wheel', wheel, { passive: false });
    return { destroy() {
        node.removeEventListener('pointerdown', down);
        node.removeEventListener('pointermove', move);
        node.removeEventListener('pointerup', up);
        node.removeEventListener('pointercancel', up);
        node.removeEventListener('wheel', wheel);
    }};
}
```
- [ ] **Step 5:** `toggleFs`（**M8 用 ref**）+ `focusOnMount`（复用 mermaid 同逻辑：关闭时焦点回触发元素）：
```ts
function toggleFs() {
    browserFs = !browserFs;
    const el = overlayEl; // M8: ref，非 document.querySelector
    if (browserFs) el?.requestFullscreen?.().catch(() => {});
    else if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
```
- [ ] **Step 6:** overlay CSS（**M4 不透明 bg + M10 补 scope 样式 + L1 border-separate**）：
```css
.rr-tbl-overlay { position: fixed; inset: 0; z-index: 1000; background: rgba(0,0,0,0.8); display: flex; flex-direction: column; }
.rr-tbl-bar {
    display: flex; align-items: center; justify-content: space-between;
    padding: 6px 10px; flex-shrink: 0;
    background: var(--rr-bg, #f6f8fa); border-bottom: 1px solid var(--rr-border-soft, #eaecef);
}
.rr-tbl-label { font-size: 12px; color: var(--rr-text-muted, #57606a); }
.rr-tbl-ctrls { display: flex; gap: 4px; }
.rr-tbl-ctrls button {
    min-width: 28px; height: 28px; padding: 0 6px;
    border: 1px solid var(--rr-border, #d0d7de); border-radius: 5px;
    background: var(--rr-card-bg, #fff); color: var(--rr-text-muted, #57606a); cursor: pointer; font-size: 14px;
}
.rr-tbl-stage { flex: 1; overflow: auto; touch-action: pan-x pan-y; padding: 12px; box-sizing: border-box; }
.rr-tbl-scroll {
    transform-origin: top left; display: inline-block;
    user-select: text; -webkit-user-select: text;
    background: var(--rr-card-bg, #fff); color: var(--rr-text, #1f2328); /* M4 */
    padding: 8px; border-radius: 8px;
}
/* M10: overlay 内表格脱离 .markdown-body scope，补回样式 */
.rr-tbl-scroll :global(table) { border-collapse: separate; border-spacing: 0; } /* L1 */
.rr-tbl-scroll :global(th),
.rr-tbl-scroll :global(td) {
    overflow-wrap: break-word; border: 1px solid var(--rr-border, #d0d7de); /* M10: 与 Task1 一致 */
    padding: 0.4rem 0.8rem; color: var(--rr-text, #1f2328);
}
.rr-tbl-scroll :global(th) { position: sticky; top: 0; background: var(--rr-card-bg, #fff); z-index: 1; }
.rr-tbl-scroll :global(a) { color: var(--rr-link, #0969da); } /* M10 */
.rr-tbl-scroll :global(:not(pre) > code) { /* M10: inline code 深色模式可读 */
    font-family: ui-monospace, Menlo, monospace;
    background: var(--rr-inline-code-bg, #eff2f5); color: var(--rr-inline-code-text, #bc4b00);
    padding: 0.15em 0.35em; border-radius: 4px;
}
.rr-tbl-overlay.rr-fs .rr-tbl-bar { position: absolute; top: 8px; right: 8px; z-index: 10; background: transparent; border: none; }
.rr-tbl-overlay.rr-fs .rr-tbl-label { display: none; }
```
- [ ] **Step 7:** `svelte-check` 0/0。
- [ ] **Step 8:** 手动验证（Playwright + 人眼）：宽表 ⛶ 显示 → 进 overlay → **选字**（`page.mouse` 长按拖选验证选区非空）→ Ctrl+滚轮缩放 / 双指 pinch（真机，L2 重点）→ Esc/✕/遮罩关闭 → 含 inline code 的表深色模式可读 → 横滑时 ⛶ 仍可见（M5）。
- [ ] **Step 9:** commit `feat(view): 手机端宽表全屏 overlay（选字复制友好）`

### Task 4: 回归 + 收尾

- [ ] **Step 1:** 375 走查：窄表（无 class 无按钮）、中表（不竖条无按钮）、宽表（横滑+⛶+全屏选字）、长行内 code（不撑破）、单元格长 URL（不撑破不竖条）、深色模式。
- [ ] **Step 2:** 桌面 1200 走查：宽表仅横滑无按钮、字号正常；**L3 补**：造 20+ 列超宽表确认桌面横滑可用。
- [ ] **Step 3:** `svelte-check` 0/0 + `bun run test` 全过（212，table 包裹断言已存在，本次无新增单测——N2）。
- [ ] **Step 4:** before/after 截图存档；**L4**：禁用 JS 打开 `/s/<token>` 截图作降级基线（表格仍可读可横滑，按钮为渐进增强）。
- [ ] **Step 5:** CLAUDE.md「当前状态」回填本次交付。
- [ ] **Step 6:** commit `docs: 表格手机端渲染修复收尾回填`

---

## Self-Review

- **审核修正全融入**：C1/H1/H2/M1/M2/M3/M4/M5/M8/M9/M10 + 加固 M6/M7/L1 均已落到对应 Step（见顶部对照表）。
- **测试诚实**：CSS/交互靠 Playwright 手动（不入 CI）；table 包裹断言已存在不重测。
- **未做可选**：L2（pinch 真机定夺，Task3 S8 重点验）、L5（夹具入库，后续）、N1（/d/[id] 深色盲区，spec §7 声明）。
- **风险**：M5 sticky 在 scroll container 内行为需真机验证（备选兄弟节点注入）；L2 双指 pinch 在 `pan-x pan-y` 下旧机型可能不触发 JS（备选 `manipulation`）。
