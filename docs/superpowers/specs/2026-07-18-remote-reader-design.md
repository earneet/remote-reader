# Remote Reader 设计文档

- **创建日期**: 2026-07-18
- **最近更新**: 2026-07-19（子计划 1 实现完成，回填实际技术栈与运行时分工）
- **状态**: 子计划 1（Web 核心）已实现并 merge master；子计划 2/3 待做
- **作者**: brainstorming 协作产出

---

## 1. 概述

Remote Reader 是一个让远程工作的 Agent 把写好的 Markdown 文档交付给人类用户阅读的工具。

**核心场景**：Agent（如 Claude Code）通过 MCP 把文档提交到本工具，拿到一个可直接查看的链接，再通过即时通信工具把链接发给用户，用户点击即看到渲染好的文档。

**一句话定位**：Agent 的"文档交付窗口"——写入侧用 MCP，阅读侧用浏览器，一次到位。

---

## 2. 目标与非目标

### 2.1 MVP 目标
- 认证客户端（Agent 背后的本地 MCP 桥）能上传 md 文档
- 上传成功返回一个**免登录、一步到渲染**的查看链接
- 提供 Web 界面渲染 md + 文件资源管理器（浏览/删除/整理）
- 支持多用户多 Agent，文档默认私有

### 2.2 非目标（YAGNI，明确推迟）
- 远程 MCP server（Phase 3 扩展）
- 文档标签、全文搜索（Phase 3）
- 指定用户/团队的精细分享（Phase 3）
- 文档版本历史、协作编辑
- 移动端原生应用

---

## 3. 整体架构

### 3.1 三大组件

```
                    ┌─────────────────────────────────────────┐
                    │   远程服务器 (单实例, 裸跑 / 可选 Docker)   │
                    │   ┌─────────────────────────────────┐   │
                    │   │  Web 应用 (apps/web, SvelteKit)   │   │
                    │   │  ├─ SvelteKit 前端页面 + SSR       │   │
                    │   │  ├─ HTTP API (+server.ts)          │   │
                    │   │  ├─ 认证: Session(浏览器)/Token(API)│   │
                    │   │  └─ md 渲染 (服务端 + 客户端增强)    │   │
                    │   └────────────┬────────────────────┘   │
                    │   ┌────────────▼────────────────────┐   │
                    │   │  存储层                            │   │
                    │   │  ├─ SQLite (app.db) 元数据/用户    │   │
                    │   │  └─ data/documents/<uid>/... md文件 │   │
                    │   └─────────────────────────────────┘   │
                    └────────▲────────────────────────────────┘
                             │ HTTPS + Bearer Token
            ┌────────────────┴────────────────┐
            │  用户本地机器                     │
            │  ┌──────────────────────────┐   │
            │  │ 本地 MCP 桥 (apps/mcp-bridge)│   │
            │  │ ├─ MCP server (stdio)       │   │
            │  │ │   暴露 upload_document     │   │
            │  │ ├─ 预置 API Token (用户配置)  │   │
            │  │ └─ HTTP client → 转发到 Web  │   │
            │  └──────────────────────────┘   │
            └─────────────────────────────────┘

            [Phase 3] Web 应用内嵌 Streamable HTTP MCP server
                      —— 复用同一套 MCP 工具逻辑, transport 不同
```

| 组件 | 位置 | 职责 | MVP |
|---|---|---|---|
| **Web 应用** | 远程服务器 | 存储 + 渲染 + 文件管理 + API + 认证 | ✅ 核心 |
| **本地 MCP 桥** | 用户机器 | 把 Agent 工具调用转发给 Web API；token 不暴露给 Agent | ✅ 核心 |
| **远程 MCP server** | Web 应用内 | Agent 直连，省掉本地桥 | 🔵 Phase 3 |

### 3.2 关键设计原则

- **MCP 工具逻辑与 transport 解耦**：工具函数定义在 `packages/shared`，本地桥用 stdio 挂载，将来远程版用 Streamable HTTP 挂载同一套函数。
- **本地桥是瘦转发层**：不做业务决策，只把 MCP 调用翻译成对 Web API 的 HTTP 请求。
- **为一次性文档优化**：主流程是"Agent 发链接 → 用户点开直接看"，文件管理器是次要的整理工具，不是入口。

---

## 4. 项目结构（monorepo）

用 Bun workspaces 管理：

```
remote_reader/
├── apps/
│   ├── web/              ← SvelteKit 全栈应用
│   │   ├─ src/routes/       (页面 + API endpoints)
│   │   ├─ src/lib/server/   (DB、认证、md 渲染、存储)
│   │   └─ src/lib/components/ (Svelte 组件: 文件树、md 渲染器)
│   └── mcp-bridge/       ← 本地 MCP 桥 (瘦转发层)
│       ├─ src/index.ts      (stdio MCP server 入口)
│       └─ src/config.ts     (读取预置 token / 服务器地址)
├── packages/
│   └── shared/           ← 三方共享
│       ├─ src/tools/        (MCP 工具定义: upload_document)
│       ├─ src/api-client/   (调用 Web API 的 HTTP client)
│       └─ src/types/        (Document/User/ApiToken 等类型)
├── data/                 ← 运行时数据 (gitignore)
│   ├─ app.db
│   └─ documents/
├── Dockerfile
├── docker-compose.yml
├── package.json          (workspaces 配置)
└── bunfig.toml
```

---

## 5. 数据模型

### 5.1 SQLite 表结构

```
users          用户
├─ id            (TEXT, 主键, cuid)
├─ email         (TEXT, 唯一)
├─ password_hash (TEXT, argon2id via @node-rs/argon2)
├─ role          (TEXT, 'admin' | 'member')
└─ created_at    (INTEGER, unix ms)

api_tokens      Agent 凭证 (每个 Agent 一个, 可撤销)
├─ id            (TEXT, 主键)
├─ user_id       (TEXT, → users.id)
├─ name          (TEXT, 如 "claude-code-laptop")
├─ token_hash    (TEXT, sha256)        ← 只存哈希
├─ last_used_at  (INTEGER, 可空)
└─ created_at    (INTEGER)

documents       文档和文件夹 (统一表, type 区分, parent_id 自引用构成目录树)
├─ id              (TEXT, 主键)
├─ owner_id        (TEXT, → users.id)
├─ parent_id       (TEXT, → documents.id, 可空)
├─ name            (TEXT)
├─ type            (TEXT, 'file' | 'folder')
├─ storage_path    (TEXT, 仅 file)
├─ content_hash    (TEXT, sha256, 仅 file)   ← 幂等判断依据
├─ size_bytes      (INTEGER, 仅 file)
└─ created_at / updated_at (INTEGER)

share_links     分享/查看链接 (上传时自动生成一个)
├─ id            (TEXT, 主键)
├─ document_id   (TEXT, → documents.id)
├─ token         (TEXT, 随机, 凭链接可读)
├─ expires_at    (INTEGER, 可空)
└─ created_at    (INTEGER)
```

### 5.2 文件系统布局（按用户隔离 + 保留目录结构）

```
data/documents/
├─ <user_id_A>/
│   ├─ reports/
│   │   ├─ weekly.md          ← storage_path 指向这里
│   │   └─ summary.md
│   └─ notes/
│       └─ idea.md
└─ <user_id_B>/
    └─ ...
```

设计要点：
- 文档和文件夹用同一张表（`type` 区分），`parent_id` 自引用构成目录树（adjacency list 模式）。
- 数据库记逻辑结构（树、归属），磁盘存物理文件，通过 `storage_path` 关联。重命名/移动只改数据库，不搬磁盘文件。
- token 只存哈希，明文仅生成时显示一次。

---

## 6. 核心流程

### 6.1 流程 A — Agent 上传文档（主流程）

```
Agent                   本地桥              Web应用              用户
 │ 1.upload_document      │                   │                   │
 │  (name,content,path)   │                   │                   │
 ├───────────────────────▶│ 2.POST +Token     │                   │
 │                        │ /api/v1/documents │                   │
 │                        ├──────────────────▶│ 3.存盘+写DB       │
 │                        │                   │ 4.生成查看token    │
 │                        │                   │   返回 url         │
 │                        │◀──────────────────┤                   │
 │ 5.{id, url}            │                   │                   │
 │◀───────────────────────┤                   │                   │
 │ 6.IM: "...👇\n https://.../s/<token>"                          │
 │──────────────────────────────────────────────────────────────▶│
 │                        │                   │ 7.用户点链接       │
 │                        │                   │   /s/<token>       │
 │                        │                   │   直接渲染,无需登录│
```

### 6.2 流程 B — 用户查看文档（点链接，一步到渲染）

- 入口：点 Agent 发的链接 `https://app/s/<token>`
- 服务器验证 `share_links.token` 有效 → 直接渲染文档返回 HTML（**免登录**）
- 页面提供「← 返回我的文档库」入口：已登录直接回 `/`；未登录跳 `/login` → `/`

### 6.3 流程 C — 用户自行管理（登录走文件管理器）

- 入口：用户自行访问 Web
- `/login`（若未登录）→ `/`（文件管理器）
- 文件管理器承担：浏览、删除、移动、重命名、建文件夹、整理

### 6.4 私有 vs 一步到渲染的调和

- 文档**默认私有**：不公开列出、不可遍历，只能通过 owner 登录或持有查看令牌访问。
- **上传时自动生成一个查看令牌**，返回 `/s/<token>` 链接。任何人凭链接可看（免登录一步到渲染）。
- owner 登录后可在 Web 上**查看并撤销**查看链接（撤销后变回严格私有，只有 owner 登录能看）。
- "分享即公开"：上传 = 自动生成一把公开钥匙，owner 可控（能撤销）。

---

## 7. HTTP API

### 7.1 Token 认证端点（给桥/Agent）— `/api/v1/*`

| 方法 | 路径 | 作用 |
|---|---|---|
| POST | `/api/v1/documents` | 上传文档（body: name, content, path），幂等 |
| GET | `/api/v1/documents?path=` | 列出某目录下内容 |
| GET | `/api/v1/documents/:id` | 获取文档内容/元数据 |
| PATCH | `/api/v1/documents/:id` | 重命名/移动 |
| DELETE | `/api/v1/documents/:id` | 删除 |

> **MVP 范围**：Token 认证 API 只实现 **POST /api/v1/documents**（给桥用）。文件管理器的增删改查走 **Session 端点**（SvelteKit form actions / `+server.ts` + cookie session）。完整的 Token API（GET/PATCH/DELETE 的 `/api/v1/*` 版本）留到 Phase 2 按需补，MVP 不做。

### 7.2 Session 端点（给浏览器）— SvelteKit 路由

| 路径 | 认证 | 作用 |
|---|---|---|
| `/s/<token>` | 公开免登录 | ★查看页（主入口），SSR 渲染 md |
| `/d/<id>` | 需登录 | 文档查看页（owner 视角），复用同一渲染组件 |
| `/` | 需登录 | 文件管理器（左目录树 + 右内容列表） |
| `/login` | 公开 | 登录 |
| `/register` | 邀请码 | 接受邀请注册（管理员邀请制） |
| `/settings/tokens` | 需登录 | API token 管理（生成/查看/撤销） |
| `/settings/shares` | 需登录 | 分享链接管理（查看/撤销） |

---

## 8. MCP 工具设计

### 8.1 工具集（MVP 仅 1 个）

| 工具 | 参数 | 行为 | 返回 |
|---|---|---|---|
| `upload_document` | `name`, `content`, `path?`（推荐路径） | 幂等上传 | `{id, url}` |

工具定义在 `packages/shared/src/tools/`，本地桥用 stdio 挂载。

### 8.2 幂等逻辑（按 path 定位 + content_hash 判断）

```
上传 (name, content, path):
  1. 算 hash = sha256(content)
  2. 解析 path → 定位/创建父文件夹
  3. 查 owner + path 下是否已有同名文档
     ├─ 没有          → 新建, 写盘, 生成 share_link
     ├─ 有, hash 变了  → 覆盖磁盘内容, 更新 content_hash/updated_at
     └─ 有, hash 相同  → 不写盘, 不更新时间戳（什么都没做）
  4. 返回 {id, url}
```

> 返回值不含 action 字段（已确认简化方案）。系统内部仍按 hash 幂等避免重复写盘，但不对 Agent 暴露 created/updated/unchanged 区分。

### 8.3 为 LLM 优化的设计

- **路径用 POSIX 风格字符串**（`"reports/weekly.md"`），不要求 Agent 传 folder id。系统按 `/` 拆分自动解析为目录树。
- 工具描述即"使用说明书"，会引导 Agent 上传后把 URL 发给用户（实现"Agent 通过 IM 通知用户"）。

---

## 9. 前端结构（SvelteKit）

### 9.1 md 渲染策略

```
md 原文
  ↓ 服务端 (markdown-it + Shiki)
  │  ├─ GFM 表格/任务列表
  │  ├─ 代码块语法高亮 (Shiki, 仅预载 ~15 常用语言)
  │  └─ XSS 防护: 默认不渲染原始 HTML
  ↓ 产出 HTML
  ↓ 客户端增强 (按需)
     ├─ Mermaid 流程图 (mermaid.js)
     └─ 数学公式 (KaTeX)
```

### 9.2 重心

查看页 `/s/<token>` 是主入口，文件管理器是次要整理工具。`/s/<token>` 与 `/d/<id>` 共用同一 md 渲染组件，区别仅在认证方式。

---

## 10. 技术选型（基于 2026-07 实际查证 + 实现期修正）

| 关注点 | 选型 | 查证/修正依据 |
|---|---|---|
| 包管理 / dev·build 宿主 | **Bun** | 一站式，原生 TS；用作 `install` / `vite dev` / `vite build` 的宿主 |
| 全栈框架 | **SvelteKit** | 混合渲染（首屏快+交互流畅），开发快，适合内容型应用 |
| 构建/部署 | **adapter-node + `node build/index.js`** | ⚠️ 生产用 **node** 启动（非 `bun run`）：better-sqlite3 在 bun 直接运行时加载失败。不用 `bun build --compile`（oven-sh/bun#15734） |
| 测试 | **vitest（node 运行时）** | `bun run test` 经 vitest 的 node shebang 在 node 下执行；同上 better-sqlite3 原因，不能用 `bun test` |
| 数据库访问 | **Drizzle ORM + better-sqlite3** | ⚠️ **不用 `bun:sqlite`**：Vite SSR 不解析 `bun:*`（详见 §15 运行时分工） |
| md 解析 | **markdown-it** | 默认安全（`html:false`）+ 100% CommonMark，契合 XSS 防护 |
| 代码高亮 | **Shiki** | 准确度最高（VS Code 同款）；只预载 ~15 常用语言，避免全语言 bundle 性能问题 |
| 图表/公式 | **Mermaid.js + KaTeX** | 客户端按需渲染（子计划 3） |
| 密码哈希 | **`@node-rs/argon2` (argon2id)** | ⚠️ **不用 `Bun.password`**：同上 Vite SSR 不认 `Bun.*`。`Algorithm` 是 const enum，与 verbatimModuleSyntax/isolatedModules 冲突，故用字面量 `ARGON2ID=2` |
| Session 签名 | **HMAC-SHA256 + timingSafeEqual** | `node:crypto`；token 含 exp 服务端校验；生产缺 `SESSION_SECRET` 启动期 fail-fast |
| MCP SDK | **@modelcontextprotocol/sdk** | 官方 TS SDK，最先支持 Streamable HTTP（利好 Phase 3）；子计划 2 引入 |

> **关键约束（实现期发现，原设计未预见）**：SvelteKit 的 SSR 在 Vite 下运行，**Vite 不识别 Bun 专属模块/全局**（`bun:sqlite`、`Bun.*`），导入会在 SSR/构建期失败。故所有 `apps/web` 服务端代码改用 node 兼容的 `better-sqlite3` / `@node-rs/argon2` / `node:crypto`。这带来反向约束：`better-sqlite3` 是原生 addon，**bun 直接运行时（`bun -e`/`bun run *.ts`/`bun test`）加载失败**，只在 `bun + vite dev` 下可用——因此测试用 vitest（node）、生产用 `node build/index.js`。详见 §15。

---

## 11. 安全清单（实现现状）

| 关注点 | 处理 |
|---|---|
| 路径穿越 | Agent 传的 **`path` 与 `name` 都过 `parsePath`**（禁止 `..`/绝对路径/null byte/Windows 非法字符），拼成单一字符串再取末段为文件名；`path.join` 归一化无法逃出 owner 目录。⚠️ 曾遗漏 `name`（review CRITICAL），已修 |
| md XSS | 服务端渲染默认不渲染原始 HTML（markdown-it `html:false`）；产物经 `{@html}` 输出受信 HTML |
| API token | 只存 sha256 哈希（`hashToken`）；明文仅生成时显示一次；`authenticateApiToken` 用 `innerJoin users` 防孤儿 token；传输走 HTTPS |
| Session | **HMAC-SHA256**（非自造 secret-suffix）+ **`timingSafeEqual`**（防时序）+ token 含 **exp 服务端校验**；生产缺 `SESSION_SECRET` **启动期 fail-fast**（懒触发，不破坏 build） |
| 密码安全 | argon2id（`@node-rs/argon2`） |
| 上传限制 | 单文件大小上限 `MAX_UPLOAD_BYTES`（默认 5MB，`envInt` 严格解析）+ 每 token 速率限制 `RATE_LIMIT`（默认 60/min）+ adapter-node `BODY_SIZE_LIMIT` 网关层（数字字节，须 > MAX_UPLOAD_BYTES） |
| 登录限流 | `LOGIN_RATE_LIMIT_MAX`（默认每邮箱 10/窗）防暴力破解 |
| 并发安全 | `uploadDocument` check-then-act 不跨 `await`（DB 写前置），并发同 path 不产生重复行 |
| SQL 注入 | Drizzle 参数化查询天然防；SQLite 外键约束 ON（`references()`）保数据完整 |
| CSRF | SvelteKit 表单内置防护 |
| 权限 | API 操作校验 token 归属；`/s/<token>` 凭 token 访问（设计如此，绕过 owner 检查） |
| 生产 | HTTPS；session cookie `httpOnly`/`sameSite:lax`/`secure`(prod) |

---

## 12. 分阶段交付计划

### Phase 1 — MVP：跑通主流程
- Web 骨架：SvelteKit + SQLite + Drizzle + 数据模型（users/tokens/documents/share_links）
- 认证：邀请注册 + 登录 + session
- **上传 API**：Token 认证 + 文件落盘 + content_hash 幂等 + 自动生成 share_link 返回 url
- **查看页 `/s/<token>`**：SSR 渲染 md（先不做 mermaid/math 增强）
- **本地 MCP 桥**：1 个 `upload_document` 工具（stdio）转发到 API
- 基础文件管理器（列表 + 删除）

### Phase 2 — 完善
- 文件管理器完整（目录树/移动/重命名/建文件夹）
- md 增强（Mermaid/KaTeX/Shiki）
- token 管理页 + 分享管理页（撤销/过期）

### Phase 3 — 扩展（低优先级）
- 远程 MCP server（Streamable HTTP，复用 shared 工具）
- 文档标签、全文搜索
- 指定分享（特定用户/团队）
- Dockerfile 完善

---

## 13. 未来扩展（记档，不影响 MVP）

- **文档标签**：加 `document_tags` 多对多表（documents ↔ tags），不影响现有结构。
- **全文搜索**：基于 SQLite FTS5。
- **指定分享**：加 `document_readers` 表（document_id + user_id），实现"分享给特定用户"。
- **远程 MCP server**：`packages/shared` 工具用 Streamable HTTP 挂载。

---

## 14. 实现阶段的开放决策点（待用户参与编码）

以下是有"多个合理做法"的小决策点，实现时会请用户亲手写 5-10 行代码（learning 模式）：

1. **路径 sanitize 规则**：如何过滤 `..`、绝对路径、非法字符。
2. **content_hash 幂等判定**：path 定位 + hash 比较的具体逻辑。
3. **分享 token 生成策略**：长度、字符集、熵值。
4. **上传限制的具体阈值**：单文件大小、速率窗口。
5. **md 渲染插件配置**：启用哪些 markdown-it 插件、Shiki 预载哪些语言。

> 注：上述 5 个开放决策点在子计划 1 实现中已由实现者（Claude）全部定稿：parsePath 拒绝 `..`/绝对路径/null/`\:*?"<>|`、content_hash 用 sha256 三态（created/skip/overwrite）、share token 用 `randomBytes(16)` base64url（128bit 熵）、阈值走 env（5MB / 60每分）、Shiki 预载 15 语言 + github-dark。

---

## 15. 实现现状（2026-07-19）

### 15.1 已完成：子计划 1（Web 核心闭环）

已 merge `master`（HEAD 见 git log），**58 单测 + svelte-check 0 错 + 生产冒烟 + e2e 全过**。已实现端点：

| 路径 | 认证 | 状态 |
|---|---|---|
| `POST /api/v1/documents` | API token | ✅ 幂等上传（content_hash），返回 `{id, url}` |
| `GET /s/<token>` | 公开免登录 | ✅ SSR 渲染 md（markdown-it + Shiki） |
| `/register` | 邀请码 | ✅ 首用户自动 admin |
| `/login` | 公开 | ✅ argon2id + 限流 |
| `/` | 需登录 | ⚠️ 占位首页（文件管理器在子计划 3） |

**未实现（原 §7 设计中标注的）**：`/d/<id>`、`/settings/tokens`、`/settings/shares`、GET/PATCH/DELETE `/api/v1/documents`——属 Phase 2/3。API token 暂只能用 `node scripts/seed-token.mjs <email>` 生成；无 logout 路由（`clearSessionCookie` 已备）。

### 15.2 运行时分工（关键，实现期确定）

| 场景 | 命令 | 运行时 |
|---|---|---|
| 装依赖 | `bun install` | bun |
| dev | `bun --filter remote-reader-web dev` | bun + vite（better-sqlite3 此路径可加载） |
| build | `bun --filter remote-reader-web build` | bun + vite（仅打包，不加载 addon） |
| 测试 | `bun run test` | **node**（vitest 经 node shebang 执行） |
| 生产 | `node apps/web/build/index.js` | **node**（adapter-node 产物） |

⚠️ 生产入口是 `build/index.js`（启动 HTTP server），**不是** `build/handler.js`（仅导出 handler）。`BODY_SIZE_LIMIT` 必须是字节数（数字，如 `8388608`），不接受 `8MB`。生产须设 `SESSION_SECRET`，否则首个请求 fail-fast。

### 15.3 待做

- **子计划 2**：本地 MCP 桥（`apps/mcp-bridge`，stdio，1 个 `upload_document` 工具转发到 API，桥持有 token）——核心流程缺失的另一半。
- **子计划 3**：文件管理器 UI（列表/删除/移动/重命名）+ 分享撤销管理页 + token 管理 UI + logout 路由 + Docker。

### 15.4 Pre-merge review 修复要点（多 Agent 交叉验证）

子计划 1 合并前经 5 维度 finder + 每 finding 2 对抗复核的 review，修了 12 项，关键的：上传 `name` 路径穿越（CRITICAL）、session 改 HMAC+timingSafeEqual+fail-fast+exp（HIGH）、登录限流、上传并发竞态重排、`envInt` 严格解析、markdown/shiki 健壮性。详见 git log 中 `review A/B/...` 系列 commit。

---

## 附录：用户决策记录

本次设计经以下关键决策收敛（均由用户拍板）：

1. 部署架构：Web 应用（远程）+ 本地 MCP 桥（用户机）+ 可选远程 MCP server（低优先级）
2. 技术栈：TypeScript + Bun（经联网查证，对比 Python/Go 后选定）
3. 前端：SvelteKit 全栈
4. 使用规模：多人多 Agent
5. 文档可见性：默认私有 + 可分享
6. 部署：单实例拓扑 + 默认裸跑开发 + 附带 Dockerfile
7. 存储：SQLite + 本地文件系统
8. MCP 工具：仅 1 个幂等 `upload_document`，返回简化为 `{id, url}`
9. 查看：上传返回 `/s/<token>` 免登录一步到渲染
10. 通知：Agent 的 IM 通知是独立过程，与上传结果解耦
