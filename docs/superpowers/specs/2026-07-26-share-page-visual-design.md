# /s/<token> 查看页渲染视觉改造 · 设计 spec

- 日期：2026-07-26
- 状态：已与用户对齐，待写实施计划
- 范围：免登录查看页 `/s/<token>`（含其依赖的共享组件与服务端 markdown 渲染）
- 非范围：owner 页 `/d/[id]`、文件管理器、认证页（可后续复用同套组件，本次不动）
- 视觉参照（brainstorm mockup）：`.superpowers/brainstorm/3892335-1785048978/content/` 下 `current-state.html` / `mockup-final.html` / `responsive-mermaid.html`

## 1. 目标

1. 修掉"手机上内容偏左、只占半屏"的布局 bug。
2. 桌面端文档区加宽，技术内容（代码/表格/图）更舒展。
3. 引入深色模式（跟随系统 + 手动切换 + 记忆）。
4. Mermaid 图独立成"浮卡"，支持缩放、拖动平移、全屏查看，便于聚焦局部。
5. 整体视觉从"朴素 GitHub"升级为"精修 GitHub"（柔和现代：浅灰底 + 白色文档卡 + 柔和阴影 + 圆角）。
6. 不破坏现有 200 单测、`svelte-check` 0/0、桥 tsc 0 错。

## 2. 背景与问题诊断

### 2.1 当前实现基线
- 容器：`MarkdownViewer.svelte` 的 `.markdown-body { max-width:760px; margin:0 auto; padding:2rem }`，颜色硬编码（GitHub 浅色）。
- markdown 服务端渲染：`apps/web/src/lib/server/markdown.ts`（markdown-it + Shiki `github-dark`，math 规则，缓存）。
- 客户端增强：`MarkdownViewer.svelte` 内 `enhanceMermaid`（mermaid 硬编码 `theme:'dark'`）+ `enhanceKatex`。
- 深色模式：无。
- 查看页：`routes/s/[token]/+page.svelte`，顶部一条 `← 返回我的文档库` 链接 + `<MarkdownViewer>`。

### 2.2 "手机偏左半屏"根因（bug）
`.markdown-body` 用 `max-width + margin:auto`，当视口 < 760 时不限制宽度、本应居中。但正文里任何**宽于视口的内容**会把它撑到 >100vw，此时 `margin:auto` 按"撑大后的宽度"居中 → 左侧留白正常、右侧溢出屏幕 → 视觉上内容偏左半屏。元凶（已读源码确认）：
- `table`（`MarkdownViewer.svelte:81-89`）：只设边框，无 overflow 包装 → 宽表必撑破。
- `.mermaid-rendered`（`:96-99`）：内含 `mermaid.render` 产出的定宽 SVG → 必撑破。

### 2.3 其他现状问题
- 桌面 760px 对含代码/表格/图的技术文档偏窄。
- mermaid 渲染后尺寸固定，复杂图看不清细节，无法缩放/聚焦。
- mermaid 主题硬编码 `dark`，与浅色正文不协调。
- 纯白背景无容器层次感，视觉偏朴素。

## 3. 设计决策

### 3.1 视觉系统（CSS 变量驱动，浅/深双值）

所有颜色定义为 CSS 变量，便于深浅切换。变量名前缀 `--rr-`（remote-reader）。

| token（变量名） | 浅色 | 深色（`[data-theme="dark"]` 覆盖） |
|---|---|---|
| `--rr-bg` | `#f6f8fa` | `#0d1117` |
| `--rr-card-bg` | `#ffffff` | `#161b22` |
| `--rr-card-border` | `transparent` | `#21262d` |
| `--rr-text` | `#1f2328` | `#c9d1d9` |
| `--rr-text-muted` | `#57606a` | `#8b949e` |
| `--rr-link` | `#0969da` | `#58a6ff` |
| `--rr-border` | `#d0d7de` | `#21262d` |
| `--rr-border-soft` | `#eaecef` | `#21262d` |
| `--rr-code-bg`（见注） | `#1e2228` | `#0d1117` |
| `--rr-inline-code-bg` | `#eff2f5` | `rgba(110,118,129,.28)` |
| `--rr-inline-code-text` | `#bc4b00` | `#e3b341` |
| `--rr-shadow` | `0 1px 3px rgba(0,0,0,.05), 0 10px 28px rgba(0,0,0,.06)` | `0 10px 28px rgba(0,0,0,.45)` |
| `--rr-toggle-bg` | `#eaeef1` | `#21262d` |

其他：
- 字体：系统字体栈 `system-ui, -apple-system, "Segoe UI", sans-serif`（正文）；`ui-monospace, SFMono-Regular, Menlo, monospace`（代码）。**不引入网络字体**（契合"一步查看、轻量、离线友好"理念）。
- 正文：16px / line-height 1.75。
- 宽度：`.markdown-body` `max-width: 960px`，居中。
- 圆角：文档卡 13px / 代码块 8px / mermaid 浮卡 10px / 切换按钮 8px。
- **代码块始终深色**（Shiki 保持单主题 `github-dark`，两态都用）——省去双主题切换，且浅页配深代码块是现代文档通行做法。注：Shiki 输出的 `<pre>` 带 inline style 背景（github-dark 约 `#24292e`），会覆盖 `--rr-code-bg`；故代码块实际背景以 Shiki 主题为准、两态一致，CSS 仅统一圆角/内边距，并为深色态加 `1px solid var(--rr-border)` 边框。`--rr-code-bg` 仅用于 mermaid 渲染失败时的回退 `<pre>`。
- **代码块字体（等宽 / ASCII flow 图友好）**：字体栈 `ui-monospace, 'SF Mono', 'Cascadia Code', Consolas, 'Liberation Mono', 'DejaVu Sans Mono', Menlo, monospace`；并强制 `font-variant-ligatures: none`（防 `->`/`=>`/`>=` 被连字成箭头破坏 ASCII 图对齐——最易漏且杀伤最大的一条）、`tab-size: 4`、`white-space: pre`。同时服务普通代码块与 box-drawing 字符画的 ASCII flow 图。**caveat**：CJK 字符在等宽字体里是全角（2× 宽），ASCII 图若混中文必然错位——字体固有特性，纯 ASCII/box-drawing 图可完美对齐。
- H1/H2 保留底部细分割线（GitHub 风），颜色用 `--rr-border-soft`。

### 3.2 响应式与防溢出修复

- `.markdown-body`：`width:100%; box-sizing:border-box; min-width:0; max-width:960px; margin:0 auto`。
- `@media (max-width:768px)`：`padding: 2rem → 1rem`。
- **`table` 在 SSR 端包壳**：改 `markdown.ts` 的 `table_open` / `table_close` 渲染规则，输出 `<div class="rr-table-wrap"><table>...</table></div>`；`.rr-table-wrap { overflow-x:auto; max-width:100% }`。
  - 选 SSR 端而非客户端 JS：首屏即正确、无闪烁，与项目"markdown 服务端渲染"一致。
- `pre`：保留 `overflow-x:auto`，加 `max-width:100%`。
- `img`、mermaid SVG：`max-width:100%`。

### 3.3 深色模式

- 主题属性：`<html data-theme="light|dark">`（由防 FOUC 脚本与 ThemeToggle 设写）。
- 来源优先级：`localStorage('rr-theme')` > `prefers-color-scheme` > `light`。
- **作用域严格收窄到 `/s/`（关键设计决策）**：变量定义、body 背景、`color-scheme` 全部放在 `/s/[token]/+page.svelte` 的 `.share-root` 根容器上（`.share-root { --rr-*浅值...; min-height:100vh; background:var(--rr-bg); color:var(--rr-text); color-scheme:light }` + `:global([data-theme="dark"]) .share-root { --rr-*深值...; color-scheme:dark }`），**绝不放进 `+layout.svelte` 的 `:global(:root)` / `:global(body)`**。原因：`+layout.svelte` 是全站根布局（`/`、`/login`、`/register`、`/settings`、文件管理器、`/d/[id]` 都走它，且无 `s/+layout.svelte` 子布局可收窄）。若把 `:global(body)` 背景 + `[data-theme="dark"]` 放 `:root`，则系统深色用户、或曾在 `/s/` 切过深色（localStorage 持久 + SPA 导航 `<html data-theme>` 残留）的人，访问这些"非范围"页面时会出现"深底 + 浅色硬编码字"不可读。收窄到 `.share-root` 后，非 `/s/` 页面完全不响应 `data-theme`。
- **`MarkdownViewer` 的 `var()` 全部带浅色 fallback**（如 `color: var(--rr-text, #1f2328)`）。这样 `/d/[id]` 共用同一组件时，因其无 `.share-root` 祖先提供变量，自动回退到浅色硬编码值；且 `MarkdownViewer` 内部不再用 `[data-theme]` 选择器，深色变量覆盖只在 `.share-root` 内触发 → `/d/[id]` 视觉零影响，契合"非范围"约定。
- **防 FOUC**：`app.html` 的 `<head>` 内联同步脚本（**必须带 `nonce="%sveltekit.nonce%"`** 以满足项目 CSP `script-src`——见 §6 风险），在 body 渲染前读 localStorage + `prefers-color-scheme` 并设 `document.documentElement.dataset.theme`。`.share-root` 的 CSS 据此首屏即正确着色，无闪白。
- 新增 `ThemeToggle.svelte`：查看页右上角圆形按钮（月亮=当前浅可切深 / 太阳=当前深可切浅）。点击 → 切 `<html data-theme>` + 写 `localStorage('rr-theme')`。
- **mermaid 随主题切换**：初始化时按当前 `data-theme` 选 `default`(浅) / `dark`(深)；用 `MutationObserver` 观察根元素 `data-theme` 变化，切换后重渲所有已渲染的 mermaid 实例（重新跑 render 并替换 DOM）。

### 3.4 Mermaid 浮卡交互（新增 `MermaidViewer.svelte`）

把原 `MarkdownViewer` 里的 mermaid 增强（找 `code.language-mermaid` → render → 替换）迁到独立组件，并升级为可交互浮卡。

- DOM 结构（每个 mermaid 块渲染为）：
  ```
  <div class="rr-mermaid-card">
    <div class="rr-mermaid-bar">
      <span class="rr-mermaid-label">图表</span>
      <div class="rr-mermaid-ctrls"> − / 百分比 / + / ⤢全屏 </div>
    </div>
    <div class="rr-mermaid-canvas"> [SVG] </div>
  </div>
  ```
- 缩放：用 CSS `zoom: z`（**非** `transform: scale`——transform 不影响布局，无法触发 `overflow:auto` 的溢出滚动条，§3.4 的拖动平移会失效；`zoom` 会重排，溢出才成立）；`z` 状态：初始 1，步进 0.2，范围 [0.5, 3]；`−`/`+` 调整，百分比显示 `Math.round(z*100)%`，重置并入"双击百分比 = 回到 100%"。
- 拖动平移：画布 `overflow:auto`；`z>1` 时 `cursor:grab`，mousedown + mousemove 实现拖动滚动（移动端友好：保留原生触摸滚动）。
- 全屏 lightbox：`⤢` 开 `<div class="rr-mermaid-fullscreen">` fixed overlay（同组件内 `{#if}`），内含放大版 SVG + 控件 + 关闭；Esc / 点遮罩关闭。
- 渲染时机与主题：mermaid 懒加载（首次出现才 `import('mermaid')`），按当前主题初始化；主题切换时所有已渲染实例重渲。
- 失败兜底：保留现有 `try/catch` + console.warn，渲染失败时回退显示原始代码文本（用 `<pre>`）。

## 4. 实现范围（文件级）

| 文件 | 改动 |
|---|---|
| `apps/web/src/app.html` | `<head>` 加内联防 FOUC 同步脚本（**带 `nonce="%sveltekit.nonce%"`**，读 localStorage/prefers → 设 `document.documentElement.dataset.theme`） |
| `apps/web/src/lib/components/MarkdownViewer.svelte` | 颜色硬编码 → `var(--rr-*, 浅色fallback)`（带 fallback 供 `/d/[id]` 共用零影响）；宽度 760→960；防溢出；移除 mermaid（迁出）；保留 katex |
| `apps/web/src/lib/components/MermaidViewer.svelte` | **新增**：浮卡 + 缩放(zoom) + 拖动 + 全屏 + 主题跟随；`securityLevel:'strict'` 显式声明；拖动 listener 在 onDestroy 清理 |
| `apps/web/src/lib/components/ThemeToggle.svelte` | **新增**：深色模式切换按钮（切 `<html data-theme>` + 写 localStorage） |
| `apps/web/src/routes/s/[token]/+page.svelte` | **新增 `.share-root` 根容器**（承载 `--rr-*` 变量浅/深、`min-height:100vh` 背景、`color-scheme`）+ 顶栏（左返回 / 右 ThemeToggle）；移除旧 `.back` |
| `apps/web/src/lib/server/markdown.ts` | `table_open`/`table_close` 包 `<div class="rr-table-wrap">`（SSR 端） |

`apps/web/src/routes/+layout.svelte`：**不动**（深色变量 scope 到 `.share-root`，避免污染全站）。`apps/web/src/routes/s/[token]/+page.server.ts`：不动。
| `apps/web/src/lib/server/markdown.ts` | `table_open`/`table_close` 包 `<div class="rr-table-wrap">`（SSR 端） |

`apps/web/src/routes/s/[token]/+page.server.ts`：不动（数据加载无关视觉）。

## 5. 测试策略

- **新增单测**：`markdown.ts` table 包裹——给定含表格的 markdown，断言渲染 HTML 含 `<div class="rr-table-wrap"><table>` 结构（在 `apps/web/tests/` 下，复用现有 vitest 配置）。
- **回归**：`bun run test` 全绿（现有 200 + 新增）；`bun --filter remote-reader-web check` 0/0；`bun --filter remote-reader-mcp-bridge check` 0 错。
- **手动验证**（实现后）：
  - 浅/深切换：按钮切换、刷新后记忆、跟随系统。
  - 手机响应式：Chrome DevTools 375 视口，确认居中、表格/图横向滚动不撑破。
  - mermaid：缩放、拖动、全屏、主题切换后重渲。
  - 代码块两态都深色、行内 code 配色、链接色。
  - ASCII flow 图（box-drawing 字符）在代码块里对齐正确、连字不破坏（验证含 `->` `=>` `>=` 的图与 `┌─┐│└─┘` 框线图）。

## 6. 风险与取舍

- **代码块始终深色**：牺牲了"纯浅色模式全浅"的一致性，换来不做 Shiki 双主题切换的简化 + 现代文档观感。已与用户对齐。
- **系统字体栈 vs 网络字体**：选系统字体（零网络依赖、中文字体不臆肿），代价是不同设备字形略有差异。契合查看页轻量理念。
- **mermaid 重渲成本**：主题切换时重渲所有 mermaid 实例。文档通常 mermaid 数量少（0–3 个），可接受；若极端多需考虑缓存。
- **SSR table 包壳改动 markdown.ts**：动了共享渲染层，影响所有用 `renderMarkdown` 的页面（查看页 + owner 页 `/d/[id]`）。`/d/[id]` 也渲染 markdown，包壳对它同样有益（防溢出），属正向副作用，需在 `/d/[id]` 回归确认无样式破坏。
- **CSS 变量与 body 背景 scope 到 `/s/` 的 `.share-root`（非 `+layout.svelte`）**：`+layout.svelte` 是全站根布局，若把 `:global(body)` 背景 + `[data-theme="dark"]` 放 `:root`，深色态会污染 `/`、`/login`、`/settings`、`/d/[id]` 等非范围路由（深底 + 浅色硬编码字不可读，已审查验证）。收窄到 `.share-root` + MarkdownViewer var() 带浅色 fallback → 非 `/s/` 页面与 `/d/[id]`（共用 MarkdownViewer）均零影响。
- **app.html 防 FOUC 内联脚本与 CSP**：项目 CSP（`svelte.config.js`，当前 report-only）`script-src` 不含 `'unsafe-inline'`、未开 nonce/hash 模式，故内联脚本必须带 `nonce="%sveltekit.nonce%"`（SvelteKit 在 csp 启用时把占位符替换为真 nonce 并自动加入白名单；它不会扫描 app.html 手写脚本自动加 nonce）。当前 report-only 下不阻断但 dev 期会刷 `/api/csp-report` stderr；转 enforcing（CLAUDE.md 既定路线）前必须已带 nonce，否则脚本被拦、首屏闪白回归。
- **mermaid 缩放用 CSS `zoom`**：非标准属性，兼容底线 = Chrome/Edge/Safari 全版本 + Firefox 126+（2024-05）。选 `zoom` 而非 `transform:scale` 是因 transform 不影响布局、无法触发 overflow 拖动滚动。嵌入式/老 WebView2 需实测。
- **mermaid 防御深度**：`loadMermaid` 显式 `securityLevel:'strict'`（mermaid 11 默认即 strict，但显式声明防未来误改为 loose 致 `{@html}`/innerHTML 注入成 XSS 面——与 markdown-it `html:false`、CSP 同属多层防线）。

## 7. 决策来源（brainstorm 记录）

- 视觉方向：A · 精修 GitHub（用户在三选一中选择）。
- 深色模式触发：跟随系统 + 切换按钮 + 记忆。
- 桌面宽度：960px（技术文档优先）。
- Mermaid 交互：内联缩放 + 全屏按钮。
