# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Remote Reader 让远程工作的 Agent 通过 MCP 上传 Markdown 文档，用户在浏览器查看。核心场景：Agent 上传文档 → 拿到免登录查看链接 → 通过 IM 发给用户 → 用户点击一步看到渲染结果。

## 当前状态

**子计划 1（Web 应用核心）已实现并 merge `master`**：上传 API（`POST /api/v1/documents`，token 认证 + content_hash 幂等）+ 免登录查看页 `/s/<token>`（markdown-it + Shiki SSR）+ 注册/登录/session。58 单测 + svelte-check 0 错 + 生产冒烟（`node apps/web/build/index.js`）+ e2e 全过。

- 子计划 1：✅ 完成（实现计划 `docs/superpowers/plans/2026-07-18-web-core.md`，已执行完毕）
- 子计划 2（本地 MCP 桥 `apps/mcp-bridge`）：🚧 未开始——核心流程缺失的另一半
- 子计划 3（文件管理器 UI + 分享/token 管理 + Docker）：📋 未开始

产品/使用/设计文档：`docs/PRODUCT.md`、`docs/USER_GUIDE.md`、`docs/superpowers/specs/2026-07-18-remote-reader-design.md`（含 §15 实现现状）。**改动架构前必读 spec。**

## 架构（Big Picture）

三大组件（详见 spec §3）：

- **Web 应用**（`apps/web`，SvelteKit 全栈）：存储 + md 渲染 + HTTP API + 认证，部署在远程服务器（单实例）
- **本地 MCP 桥**（`apps/mcp-bridge`）：部署在用户机器，把 Agent 的 MCP 工具调用（stdio）转发为对 Web API 的 HTTP 请求；持有 API token，不暴露给 Agent
- **共享层**（`packages/shared`）：MCP 工具定义、API client、类型 —— 被 web 和 bridge 共用

主流程：Agent 调 `upload_document` → 桥转发 → Web API 落盘 + 自动生成 share token → 返回 `/s/<token>` URL → 用户点链接免登录一步查看。

关键设计原则（spec §3.2 / §6.4 / §8）：

- **MCP 工具逻辑与 transport 解耦**：工具函数写在 `packages/shared`，本地桥用 stdio 挂载，未来远程 MCP server 用 Streamable HTTP 挂载同一套函数
- **为一次性文档优化**：查看页 `/s/<token>` 是主入口（免登录一步到渲染），文件管理器是次要整理工具
- **默认私有 + 可分享**：文档不公开遍历，凭 share token 或 owner 登录访问；上传自动生成一个查看 token，owner 可撤销
- **幂等上传**：按 path 定位 + content_hash 判断 created/覆盖/跳过；上传工具只返回 `{id, url}`（无 action 字段）

## 技术栈

TypeScript · Bun（包管理 + dev/build 宿主；测试与生产跑在 node） · SvelteKit（全栈，SSR+CSR 混合） · Drizzle ORM + SQLite（`better-sqlite3` 驱动） · markdown-it（服务端渲染，`html:false` 防 XSS） · Shiki（代码高亮，仅预载 ~15 种语言） · Mermaid.js + KaTeX（客户端增强） · `@node-rs/argon2` argon2id（密码哈希） · vitest（node 下跑测试） · `@modelcontextprotocol/sdk`

> ⚠️ **为何不用 `bun:sqlite` / `Bun.password`**：SvelteKit 的 SSR 在 Vite 下运行，Vite 不解析 Bun 专属模块（`bun:*`/`Bun.*`）。故服务端一律用 node 兼容的 `better-sqlite3` / `@node-rs/argon2` / `node:crypto`。代价：`better-sqlite3` 在 bun 直接运行时加载失败，所以测试用 vitest（node）、生产用 `node apps/web/build/index.js`。详见下方「开发命令」的运行时分工注。

## Monorepo 结构

Bun workspaces，`apps/web` 与 `apps/mcp-bridge` 都依赖 `@remote-reader/shared`（`workspace:*`）。SvelteKit alias：`$server`→`src/lib/server`、`$components`→`src/lib/components`、`$shared`→`packages/shared/src`。

## 开发命令

> 以下命令在子计划 1 Task 1 初始化 monorepo 后可用（当前尚未实现）。

```bash
bun install                                    # 装所有 workspace 依赖
bun --filter remote-reader-web dev             # 启动 SvelteKit dev (http://localhost:5173)
bun --filter remote-reader-web build           # 构建（adapter-node）
bun --filter remote-reader-web check           # svelte-check 类型检查
bun --filter remote-reader-web db:generate     # 生成 Drizzle migration
bun --filter remote-reader-web db:migrate      # 执行 migration
bun run test                                   # 跑所有测试（vitest，node 运行时）
bun run test apps/web/tests/auth.test.ts       # 跑单个测试文件
bun run test -t "测试名片段"                    # 按测试名过滤
```

> **运行时分工（已验证）**：`better-sqlite3` 是原生 addon，**bun 直接运行时（`bun -e`/`bun run *.ts`）加载失败**（oven-sh/bun#4290），但 `bun + vite dev` 下可加载。因此：测试用 **vitest**（`bun run test`，经 vitest 的 node shebang 在 node 下跑）；dev/build 用 bun；**生产用 `node apps/web/build/index.js`**（adapter-node 产物，勿用 `bun run` 启服务；入口是 index.js 不是 handler.js）。

⚠️ **部署注意**：用 `adapter-node` 产物 + **`node apps/web/build/index.js`** 启动（不要 `bun run` 启服务，会触发 better-sqlite3 加载失败），**不要用 `bun build --compile`** 打单二进制（oven-sh/bun#15734 已知不兼容，详见 spec §10）。生产必填 `SESSION_SECRET`（缺失 fail-fast）；`BODY_SIZE_LIMIT` 必须是字节数（数字，须 > `MAX_UPLOAD_BYTES`）。

## 环境变量（见 `.env.example`）

`DATABASE_PATH`、`DATA_DIR`、`BASE_URL`、`SESSION_SECRET`、`INITIAL_INVITE_CODE`（注册首个管理员所需）、`MAX_UPLOAD_BYTES`。运行时数据在 `data/`（已 gitignore，**绝不入库**）。

## 安全要点（项目特有）

- **路径穿越**：Agent 传的 path 必须经 `parsePath`（`packages/shared/src/paths.ts`）sanitize，禁 `..`/绝对路径/null byte
- **md XSS**：markdown-it 必须保持 `html:false`；渲染产物用 `{@html}` 输出（受信 HTML）
- **凭证**：API token 只存 sha256 哈希，明文仅生成时显示一次；密码用 argon2id
- **权限**：API 操作校验 `owner_id == token.user_id`；`/s/<token>` 凭 token 访问（设计如此，绕过 owner 检查）

## 文档指针

- 设计 spec（权威）：`docs/superpowers/specs/2026-07-18-remote-reader-design.md`
- 实现计划：`docs/superpowers/plans/`（按子计划编号）
