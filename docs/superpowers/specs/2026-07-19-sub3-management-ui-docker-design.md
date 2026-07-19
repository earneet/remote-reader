# Remote Reader 子计划 3 设计：管理 UI + Docker

- **创建日期**: 2026-07-19
- **状态**: 设计阶段（待 review → writing-plans）
- **依据**: 主 spec `2026-07-18-remote-reader-design.md`（§5.2 / §7.2 / §12 Phase 2 / §15.3）
- **作者**: brainstorming 协作产出

---

## 1. 背景与范围

子计划 1（Web 核心）+ 子计划 2（本地 MCP 桥）已 merge master，主流程（Agent 上传 → 免登录查看）已闭环。子计划 3 补齐**用户侧管理 UI**与**部署收尾**：让 owner 能在浏览器里整理文档、管理分享链接与 API token、登出，并提供 Docker 一键部署。

### 1.1 纳入范围

**核心五项**（CLAUDE.md 既定）：

1. 文件管理器 `/`：列表 / 删除 / 重命名 / 建文件夹
2. 分享管理页 `/settings/shares`：查看 / 撤销
3. token 管理页 `/settings/tokens`：生成 / 撤销
4. logout 路由 `/logout`
5. Docker（Dockerfile + docker-compose.yml）

**可选三项**（brainstorming 确认纳入）：

6. `/d/<id>` owner 文档查看页（复用 `/s` 的 MarkdownViewer 组件 + owner 鉴权）
7. 文件「移动」功能（DB 改 `parentId`）
8. md 增强：Mermaid 流程图 + KaTeX 数学公式（懒加载）

### 1.2 非目标（YAGNI）

- 远程 MCP server、文档标签、全文搜索、指定分享（属 Phase 3）
- 回收站 / 软删除（删除即硬删）
- 分享 token「重新生成」（撤销后需新链接就重新上传）
- token / share 过期时间的 UI 暴露（schema 支持 `expiresAt`，本期 UI 不暴露）
- 文件上传 UI（上传仍由 Agent 经 MCP 桥完成，文件管理器只做整理）

---

## 2. 关键决策（brainstorming 拍板）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 文件管理器布局 | **左目录树 + 右列表**（spec §7.2 原设计） | 层级清晰；左树兼作「移动」目标选择器，省一个独立组件 |
| md 增强加载 | **全做 + 懒加载** | `/s/<token>` 是主入口，首屏只渲染文本+高亮，按需才下载 mermaid/katex |
| 操作请求形态 | **SvelteKit form actions**（非 JSON API） | CSRF 内置、渐进增强（`use:enhance`）、redirect 自然，符合项目范式 |
| 移动的磁盘处理 | **不搬磁盘文件**（仅改 `parentId`） | spec §5.2 既定；渲染从 `storagePath` 读不受影响；省去搬文件的并发/出错面 |
| `/d/<id>` | **纳入** | 否则 owner 看自己文档只能找 share 链接，体验断裂；复用组件成本低 |

---

## 3. 架构骨架

### 3.1 路由清单（新增）

| 路由 | 认证 | `load`（取数） | `actions`（写操作） |
|---|---|---|---|
| `/` | 登录 | 当前 folder 子项 + 全量 folder 树 | `createFolder` / `rename` / `move` / `delete` |
| `/d/[id]` | 登录 + owner | 取文档内容，校验 `ownerId == user.id` | — |
| `/settings/tokens` | 登录 | owner 的 api_tokens 列表 | `create`（生成，明文返回一次）/ `revoke` |
| `/settings/shares` | 登录 | owner 文档的 share_links 列表 | `revoke` |
| `/logout` | 登录 | — | 清 cookie → redirect `/` |

`/s/<token>`（查看页）与 `/login`、`/register` 已存在，不动；仅 `/s` 页面新增客户端 md 增强逻辑。

### 3.2 数据层补函数（`apps/web/src/lib/server`，沿用现有同步 Drizzle 模式）

- **`documents.ts`**（现有 `uploadDocument` / `ensureFolder` / `findNode`）：
  - `listChildren(ownerId, parentId)`：返回某 folder 下的子 folder + file（右栏）
  - `listFolders(ownerId)`：返回 owner 的所有 folder（左栏树，客户端按 `parentId` 组装树）
  - `getOwnedDocument(id, ownerId)`：取单个文档，校验归属（`/d/[id]` 用）
  - `renameNode(ownerId, id, newName)`
  - `moveNode(ownerId, id, newParentId)`：仅改 `parentId`，不动 `storagePath`
  - `deleteNode(ownerId, id)`：级联删除（见 §4.2）
- **`shares.ts`**（现有 `createShareLink` / `getDocumentIdByShareToken`）：
  - `listSharesByOwner(ownerId)`：join documents，返回文档名 + token + 创建时间
  - `revokeShare(ownerId, token)`：删 share_links 行（校验归属，通过 document.ownerId）
- **`apitokens.ts`**（新文件）：
  - `listTokens(ownerId)`：返回 name / 创建时间 / lastUsedAt（不返回 hash）
  - `createTokenForUser(ownerId, name)`：调 `auth.generateApiToken()` 生成明文+hash，写库，返回明文一次
  - `revokeToken(ownerId, id)`：删 api_tokens 行（校验 userId 归属）
  - 注：`lastUsedAt` 由 API 认证流程写入（实现时确认 `apitoken-auth.ts` 现状，若未更新则补）

### 3.3 导航（`+layout.svelte`）

顶部栏：`[我的文档]  [设置 ▾]  <email>  [登出]`。设置下拉含「API Token」「分享链接」两项。**公开页**（`/login`、`/register`、`/s/<token>`）隐藏顶部栏，按 `data.user` 判断。

---

## 4. 管理页交互与操作语义

### 4.1 文件管理器 `/`（双栏）

- **左栏**：递归渲染 owner 的所有 folder（`listFolders`），点击切换"当前 folder"，URL 带 `?dir=<id>` 记忆位置（支持刷新/分享位置）。
- **右栏**：当前 folder 的子 folder（点击进入）+ 文件（点击 → `/d/[id]`）。
- **行内操作**（每行右侧按钮）：`✏ 重命名` / `📂 移动` / `🗑 删除`；顶部 `+ 新建文件夹`。
- 全部走 form actions + `use:enhance`（无刷新反馈）；删除/移动用浏览器 `confirm()` 二次确认（不造 modal）。

### 4.2 删除语义（硬删 + 级联）

- 删 **file**：删 DB 行 + 删磁盘文件（`storagePath`）+ 删其所有 share_links（`/s/<token>` 立即失效）。
- 删 **folder**：递归对子项执行同样删除（folder → 子 folder → … → file）。
- 磁盘文件已缺失时**不阻断** DB 删除（容错，仅记日志）。
- 事务：整个级联在单个 better-sqlite3 同步事务内（Drizzle `db.transaction`），失败回滚 DB；磁盘删除在事务后尽力执行。

### 4.3 移动语义（沿用 spec §5.2）

- 移动 = 改 `parentId`（DB），**磁盘文件不搬**，`storagePath` 保持上传时路径。
- 权衡已接受：移动后磁盘目录与逻辑结构脱节，但渲染从 `storagePath` 读、功能不受影响。
- 移动 UI：点文件的 `📂` → 左栏切"选目标"态（高亮可选 folder，禁用自身及子孙防环路）→ 点目标 folder → 提交 `moveNode`。
- 环路防护：`moveNode` 校验 `newParentId` 不能是节点自身或其子孙（DB 层拒绝）。

### 4.4 token 管理页 `/settings/tokens`

- 列表：name · 创建时间 · lastUsedAt · `[撤销]`。
- `+ 生成新 token`：输入 name 提交 → `createTokenForUser` → action 在 `return` 中带出明文 → 页面横幅显示明文 + 复制按钮 + "离开/刷新后不可再见"。
- 撤销 = 删 api_tokens 行（hash 不可逆，立即无法认证）。
- 安全：明文仅在 create action 的返回值中存在，**不入库、不入日志**。

### 4.5 分享管理页 `/settings/shares`

- 列表：文档名 · token 缩略（如 `aBc…xYz`）· 创建时间 · `[撤销]`。
- 撤销 = 删 share_links 行 → `/s/<token>` 立即 404。
- 不做"重新生成"。

### 4.6 logout `/logout`

POST action 调 `clearSessionCookie(cookies)` → `redirect(303, '/')`。用 POST（form）而非 GET，防 CSRF 误触发。

---

## 5. md 增强（Mermaid + KaTeX，懒加载）

### 5.1 服务端（markdown-it，`lib/server/markdown.ts`）

- **Mermaid**：保持普通 fence 代码块，输出 `<pre><code class="language-mermaid">…</code></pre>`，不做特殊处理（客户端识别）。
- **KaTeX**：加一个轻量 inline/block 规则，把 `$...$` / `$$...$$` 转成占位 `<span class="math inline">…</span>` / `<div class="math block">…</div>`（**只标记不渲染**，避免服务端引 katex 增大 SSR 体积、保持 XSS 安全边界）。

### 5.2 客户端（`/s/<token>`、`/d/[id]` 的 `onMount`，仅 `browser`）

- 扫描 DOM：
  - 发现 `language-mermaid` 代码块 → `await import('mermaid')` → `mermaid.run({ nodes })` 替换为 SVG。
  - 发现 `.math` 元素 → `await import('katex')` → 对每个元素 `katex.render(...)`。
- **无标记则零下载**：两库按需 dynamic import。
- 新增依赖：`mermaid`、`katex`（仅客户端 import，SSR 不碰）。

### 5.3 安全

`html:false` 不变；mermaid 渲染受信代码块、katex 渲染受信占位 span，均不引入用户原始 HTML。

---

## 6. Docker

### 6.1 Dockerfile（多阶段）

关键约束：`better-sqlite3` 是原生 addon，必须在 runtime 镜像为目标平台编译（呼应主 spec §10/§15.2）。

- **`build` 阶段**：`oven/bun` 基础镜像 → `bun install`（全量含 devDep）→ `bun --filter remote-reader-web build` → 产出 `apps/web/build/`。
- **`runtime` 阶段**：`node:22-slim` + 构建工具链（`python3` / `make` / `g++`，供 better-sqlite3 编译）→ `npm install --omit=dev`（runtime 为 node 镜像，用 npm 装生产依赖，触发 better-sqlite3 在目标平台经 node-gyp 编译；`@remote-reader/shared` 随 workspace 一并解析）→ copy `apps/web/build/` 产物（shared 已 bundle 进产物，无需单独 copy）。lockfile 用法（沿用 bun.lockb 或生成 package-lock）实现阶段定。
- **`CMD`**：`["node", "apps/web/build/index.js"]`（adapter-node 产物，**不用** `bun run` 启服务）。

### 6.2 docker-compose.yml

单服务 `web`：build context = 仓库根，端口 `3000:3000`（adapter-node 默认 3000），volume `./data:/app/data`（持久化 app.db + documents），`env_file: .env`。

### 6.3 .dockerignore

`node_modules`、`data`、`.git`、`apps/web/build`、`**/*.test.ts`。

### 6.4 必填环境变量

`SESSION_SECRET`（缺则 fail-fast）、`BASE_URL`（对外地址）、`INITIAL_INVITE_CODE`（首启注册首个 admin）。其余（`MAX_UPLOAD_BYTES`、`BODY_SIZE_LIMIT` 等）沿用 `.env.example` 默认。

---

## 7. 测试策略

沿用现有模式（vitest 在 node 下跑，lib 层单测）。

- **lib/server 新函数全补单测**：
  - `documents`：listChildren / listFolders / getOwnedDocument（含非 owner 拒绝）/ renameNode / moveNode（含环路拒绝）/ deleteNode（file + folder 级联 + share 清理 + 磁盘容错）
  - `shares`：listSharesByOwner / revokeShare（含非 owner 拒绝）
  - `apitokens`：listTokens / createTokenForUser（明文返回一次）/ revokeToken（含非 owner 拒绝）
- **路由层**（`+page.server.ts` actions）：薄封装，靠 lib 单测覆盖；不做 SvelteKit 路由级集成测（ROI 低）。
- **md**：测服务端"含 mermaid fence / math 占位"的渲染产出；客户端懒加载不单测。
- **Docker 构建冒烟**（新增）：`docker build` 成功 + `docker compose up` 起服务 + 跑一次 上传→查看→登出 闭环。
- 目标：单测 74 → ~110，`svelte-check` 0 错，桥 `tsc` 0 错，Web 生产冒烟 + Docker 冒烟全过。

---

## 8. 横切

- **schema 零改动**（documents 树 / share_links / api_tokens 均已就位）→ 无新 migration。
- **安全**：所有 load/action 校验 owner；`/d/[id]` 校验 `ownerId == user.id`；form action CSRF 由 SvelteKit 内置；token 明文只存在 create action 返回值。
- **并发**：rename/move/delete 走同步 better-sqlite3 事务，check-then-act 不跨 await（沿用 uploadDocument 模式）。
- **导航**：公开页隐藏顶部栏。

---

## 9. 与主 spec 的关系（实现后回填）

实现完成后，主 spec `2026-07-18-remote-reader-design.md` 的以下部分需更新：

- **§7.2 路由表**：`/`、`/d/<id>`、`/settings/tokens`、`/settings/shares`、`/logout` 从"未实现"改为"已实现"。
- **§12 Phase 2**：文件管理器完整、token 管理、分享管理、md 增强（Mermaid/KaTeX）勾除。
- **§15.1 实现现状表**：`/` 占位首页 → 文件管理器；新增 `/d/<id>` 行；注明 token 可在 UI 生成（不再依赖 `scripts/seed-token.mjs`）。
- **§15.3 待做**：子计划 3 移除，仅剩 Phase 3 扩展项。
- 部署章节：补 Docker 实测命令与 better-sqlite3 编译方案。

---

## 附录：开放实现决策点（learning 模式，请用户参与编码）

以下是有"多个合理做法"的点，实现时请用户亲手写 5-10 行（learning 模式约定）：

1. **移动环路检测**：`moveNode` 里如何判断 newParentId 是节点自身/子孙（递归查 parent 链 vs 维护路径前缀）。
2. **删除级联的事务边界**：DB 事务 vs 磁盘删除的先后与容错策略。
3. **mermaid/katex 客户端扫描时机**：`onMount` vs `afterUpdate`，以及动态 import 失败的降级。
4. **token 明文横幅的 UX**：复制按钮 + 自动隐藏 + 刷新后消失的具体交互。

> 以上在 writing-plans 阶段会标注为"用户实现"任务。
