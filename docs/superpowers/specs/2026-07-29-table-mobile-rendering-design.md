# 表格手机端渲染修复 — 设计 spec

> 状态：待用户 review。日期 2026-07-29。

## 1. 问题

`/s/<token>` 查看页（同样影响 `/d/[id]` owner 查看页），手机端（375 视口）markdown 表格被压成"竖条"：单元格内容垂直堆叠、列宽窄到只放一两个字、无法阅读。窄表（3 列）正常，5 列及以上的中宽/宽表受害。用户原话："大量的列被压缩成垂直的长长的一条"。

## 2. 根因（实测确认）

`apps/web/src/lib/components/MarkdownViewer.svelte:40` 的全局规则：
```css
.markdown-body { overflow-wrap: anywhere; }
```
这条是子计划 3 为修"行内 `<code>` 长无空格串撑破页面"加的（教训㉑）。`overflow-wrap` 是**继承属性**，传到所有 `td`/`th`。

`anywhere` 与 `break-word` 的关键区别：**`anywhere` 把可断点计入 `min-content` 计算**（min-content 塌缩到单字符），`break-word` 不影响 min-content。

表格默认 `table-layout: auto`，列宽由内容 `min-content` 决定。`anywhere` 让所有列 min-content 塌缩 → 表格收缩到恰好塞满父容器、**永不溢出** → `.rr-table-wrap` 的 `overflow-x: auto`（`MarkdownViewer.svelte:80-84`）永不触发 → 列被均分压成竖条。

### 实测证据（Playwright 375 视口，isMobile，三种表）

ratio = `table.scrollWidth / wrap.clientWidth`；`tdOverflowWrap` 全部测得 `'anywhere'`（继承确认）。

| 表 | 列 | 现状(anywhere) ratio | 注入 `break-word` 后 ratio | 现状视觉 |
|---|---|---|---|---|
| 窄 | 3 | 0.456 | 0.456 | 正常 |
| 中 | 5 | 1.000 | 1.000 | **竖条** |
| 宽 | 7 | 1.000 | **1.575** | **竖条** |

关键发现：现状下中/宽表 `scrollWidth` 精确等于 `wrap.clientWidth`（327），绝非巧合——正是 anywhere 把表格压到恰好塞满容器。改 `break-word` 后，中表仍 1.0（min-content ≤ 容器，按内容分宽，**不再竖条**），宽表 1.575（min-content > 容器，溢出 → 横滑触发）。

**结论：一条 `overflow-wrap: break-word` 自动完成"窄/中/宽"分档，无需 JS 测量分档、无需 fixed layout。**

## 3. 方案

### 3.1 核心修复（必做）—— MarkdownViewer.svelte 加规则

```css
.markdown-body :global(td),
.markdown-body :global(th) {
    overflow-wrap: break-word;
}
```

- 覆盖继承的 `anywhere`，恢复 min-content 正常计算。
- 用 `break-word` 而非 `normal`：长 URL / 长 code 在单元格里可换行吸收，不全靠横向滚动。

**禁用 `word-break: break-word`（C1，多 Agent 审核 + 实测复核）**：MDN 明示 `word-break: break-word` 等价于 `overflow-wrap: anywhere`（"regardless of the actual value of overflow-wrap"），会重新引入根因、抵消本修复。实测：注入 `overflow-wrap:break-word` 宽表 ratio 1.575（修复生效），再叠 `word-break:break-word` 跌回 1.000（竖条重现）。CJK 默认 `word-break:normal` 已允许字符间断行，不需要它。

**不回归验证**：行内 `<code>` 仍继承 `.markdown-body` 的 `anywhere`（防撑破，教训㉑）；代码块 `pre` 受 `white-space: pre` 保护（不允许 wrap，不受 overflow-wrap 影响）。两者均不被本规则波及。

### 3.2 增强A：手机端"溢出表格"缩字 0.9em（用户拍板：仅表格、仅需要时）

**不缩正文、不缩窄表。** 仅当客户端测量到表格溢出（break-word 后 `ratio > 1`）时，给该 wrap 加 `.rr-shrink` class，手机端 `font-size: 0.9em` 作为"挤一挤"试探：

- 缩字后重测 `ratio ≤ 1` → 保持 `.rr-shrink`（挤进视口，**不横滑、不进全屏**）。
- 缩字后仍 `ratio > 1` → 保留 `.rr-shrink` + 加 `.rr-wide`（横向滚动 + 全屏按钮）。

仅 `@media (max-width: 768px)` 生效；桌面端表格不缩字（用户确认桌面端无问题）。窄表与中宽表（不溢出）不触发缩字、字号不变。用户明确："只有当表格需要压缩的时候进行压缩"。

### 3.3 增强B：手机端宽表全屏（用户拍板：按钮触发，兼顾选字复制）

仅 `@media (max-width: 768px)`。桌面端宽表保持 `.rr-table-wrap` 的横向滚动，**不加全屏按钮**（用户确认桌面端无问题，桌面横滑即够）。

**识别**：客户端 `$effect`（与 MermaidViewer 同机制，SSR 安全、文档间导航重渲染）遍历 `.rr-table-wrap`，测 `table.scrollWidth > wrap.clientWidth + 8`（8px 阈值排除边界抖动），给该 wrap 加 `.rr-wide` class，注入一个"⛶ 全屏"按钮（右上角浮，低调样式，仅宽表出现；正常/中宽表无按钮，保持干净）。

**全屏 overlay**：复用 mermaid lightbox 的容器骨架 + class 驱动视觉全屏 + `requestFullscreen` 兜底（教训㉕：iOS Safari 无 Fullscreen API，靠 class 模拟）。

**关键差异（必须与 mermaid 区分）**：mermaid overlay 是 SVG 图表，禁选字、单指拖动平移、`touch-action: none` 全劫持——**不能照搬到表格**。表格 overlay 必须支持**选中单元格文字复制**。模型改为：

- **可滚动大画布**（`overflow: auto`）+ `transform: scale(var(--zoom))` 控制缩放。
- **单指滑动 → 原生滚动**（不劫持），自然支持长按选字复制。
- **双指 pinch → 缩放**（手势脚本只处理 ≥2 指的情况，单指完全交给浏览器）。
- **桌面**：滚轮（Ctrl）缩放 + 滚动条/触控板平移。
- `touch-action: pan-x pan-y`（单指滚动交浏览器，双指缩放由我们处理），**非** `none`。
- 表格内容 `user-select: text` 显式保证。

**关闭**：✕ 按钮 / 点遮罩空白 / Esc（同 mermaid）。

### 3.4 增强C：表头粘性（横滑/全屏时）

宽表横滑或全屏时，`th { position: sticky; top: 0 }` + 不透明背景，便于纵向对照行。**首列粘性**（`sticky; left: 0`）默认不做（用户未要求，且首列未必是 key 列；可作为后续选项）。

## 4. 不做（YAGNI）

- 视觉旋转 90° 按钮（用户：先按建议不加，看效果再定）。
- 小屏卡片化（table → cards）：保留表格语义，横滑 + 全屏已覆盖。
- 客户端测量给中宽表打 fixed/缩字档：实测 break-word 自动解决，无需。
- `screen.orientation.lock`：iOS 不支持，跨平台不一致。
- 桌面端全屏按钮：用户确认桌面端无问题，桌面宽表横向滚动即够。
- 正文整体缩字：用户明确不缩正文，仅"溢出表格"按 3.2 触发缩字。
- 窄表/中宽表缩字：不溢出则不缩，字号不变（用户"需要时才压缩"）。

## 5. 文件改动

- `apps/web/src/lib/components/MarkdownViewer.svelte`：加 3.1 / 3.2 / 3.4 的 CSS（scoped + `:global`）。
- 新建 `apps/web/src/lib/components/TableFullscreen.svelte`（或并入 MarkdownViewer）：3.3 的识别 + overlay + 缩放手势。
- 不动 `markdown.ts`（`table_open`/`table_close` 的 `.rr-table-wrap` 包裹已存在，复用）。

## 6. 测试

- **单测（vitest）**：`markdown.ts` 渲染 table 输出 `<div class="rr-table-wrap"><table>...</table></div>` 包裹（纯 HTML 断言；若已有则确认，无则补）。CSS 行为不在单测范围。
- **CSS/视觉（Playwright 手动）**：复用 `/tmp/measure-tables.cjs`（量 ratio）+ 截图人眼。确认：中宽表不再竖条（列按内容分宽）、宽表 ratio>1 横滑、窄表不变、行内长 code 不撑破（回归教训㉑）。Playwright 不入 CI（项目测试为 vitest/node），作为实现期手动验证 + 截图存档。
- **全屏交互**：svelte-check 0/0 + 手动验（选字复制可工作、双指/滚轮缩放、Esc/✕/点遮罩关闭、深色模式样式）。
- **svelte-check**：0 error / 0 warning。

## 7. 影响面

- 仅 `.markdown-body` scope（`/s/<token>` + `/d/[id]`）。
- 不波及其他路由（`/` `/login` `/settings`）。
- 深色模式：`/s/[token]` 的 `.share-root` 定义全套 `--rr-*` 变量，表格与 overlay 自动适配。**已知盲区（N1，本次不修）**：`/d/[id]/+page.svelte` 未定义任何 `--rr-*` 变量（既有缺陷，非本次引入），overlay 内 `var(--rr-*)` 走 fallback（浅色值），深色模式下 sticky th / 按钮可能与深色正文冲突——`/d/[id]` 深色模式列为已知缺陷，本 spec 不修、Task 4 不入回归。
- SSR / 无 JS 降级：`.rr-table-wrap` 的 `overflow-x:auto` 与 break-word 都在 CSS（首屏不竖条、可横滑），`.rr-shrink`/`.rr-wide`/⛶ 按钮为 JS 渐进增强，无 JS 时缺失属正常降级、非 bug。
