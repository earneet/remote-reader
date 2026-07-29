# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

Remote Reader 让远程工作的 Agent 通过 MCP 上传 Markdown 文档，用户在浏览器查看。核心场景：Agent 上传文档 → 拿到免登录查看链接 → 通过 IM 发给用户 → 用户点击一步看到渲染结果。

## 当前状态

**子计划 1/2/3 全部已实现并 merge `master`**：Web 上传 API（`POST /api/v1/documents`，token 认证 + content_hash 幂等）+ 免登录查看页 `/s/<token>`（markdown-it + Shiki SSR + Mermaid + KaTeX）+ 注册/登录/session/logout；本地 MCP 桥（`apps/mcp-bridge`，stdio，`upload_document` 工具）；文件管理器（双栏列表/预览/删除）+ `/d/<id>` owner 查看页 + API token 管理 UI（`/settings/tokens`，创建/撤销 + 一次性 reveal）+ 分享 token 管理 UI（`/settings/shares`，撤销）；速率限制（上传/登录，见 `apps/web/src/lib/server/ratelimit.ts`）；Docker（多阶段 Dockerfile + docker-compose，非 root 运行）。后续已交付：`/s/<token>` 查看页视觉改造（精修 GitHub 调性 + 深色模式 + mermaid lightbox）+ 文件管理页修复（文件树点击导航改 SvelteKit `goto` + 重命名 inline edit）。212 单测 + svelte-check 0/0 + 桥 tsc 0 错 + Docker 构建冒烟全过。

- 子计划 1：✅ 完成（`docs/superpowers/plans/2026-07-18-web-core.md`）
- 子计划 2：✅ 完成（`docs/superpowers/specs/2026-07-19-mcp-bridge-design.md` + `docs/superpowers/plans/2026-07-19-mcp-bridge.md`）
- 子计划 3：✅ 完成（`docs/superpowers/specs/2026-07-19-sub3-management-ui-docker-design.md` + `docs/superpowers/plans/2026-07-19-sub3-management-ui-docker.md`：管理 UI + md 增强 + Docker）

**安全审核修复（2026-07-19，多 Agent 审核 + 3-lens 交叉复核）**：数据完整性（C1 运行时建表 / H1-H2 写盘原子 / H3 `foreign_keys=ON` / M9 重名校验）、认证加固（H4 invite fail-fast + 注册限流 / M3 SESSION_SECRET 强度 / M7 firstUser 事务 / 登录时序恒定）、客户端安全（H6 CSP report-only / H7 referrer no-referrer / M1 cache-control no-store）、性能（M12 索引 / M13 markdown 单例+缓存 / ratelimit Map 回收）、部署（M14 BASE_URL 不硬编码 / M15 /api/health healthcheck）、代码质量（删死代码 / 单源 env / 去 any）。测试 102→159。

**全项目审查 + 修复（2026-07-24，6-Agent 并行审查 + 逐条实测复核）**：真问题 2 个——auth-routes 测试 helper 未适配 `fail()` 语义（`cd8384e` 重设计回归致 7 用例断言失效）、`BASE_URL` 生产默认 localhost 无 fail-fast（M14 半修，已加 startup-check 非 localhost 校验）；加固——db `busy_timeout` 显式化（核验 better-sqlite3 默认已 5000ms，原"无 busy_timeout"系误判）、上传 API 认证失败按 IP 限流（`AUTH_FAIL_RATE_LIMIT_MAX` 默认 30）、`docker-entrypoint.sh` 改 `#!/bin/bash`+`set -euo pipefail`；补 session/`/d/[id]`/settings/logout/文件管理器 5 处测试盲点。第二阶段复核纠正 agent 幻觉 3 处（CSP"不完整"/M7"偏差"/crypto·auth·apitoken"无测试"）+ TDD 证伪"高优先"误判 3 处（busy_timeout/markdown 丢内容/deleteNode throw）。测试 159→200。

**下一步（低优先）**：spec §12 Phase 3 扩展（远程 MCP server / 多文档批量上传等），详见 spec §15.3 待做；CSP 由 report-only 转 enforcing（需线上观察 mermaid/katex 违规）；session 服务端撤销表 / 审计日志（设计级，未做）。

**桥运行时**：无原生依赖（纯 fetch + MCP SDK）→ `bun apps/mcp-bridge/src/index.ts` 直跑；`tsc --noEmit` 类型检查（`bun --filter remote-reader-mcp-bridge check`）。配置 = `~/.config/remote-reader/config.json`（XDG）默认 + `REMOTE_READER_URL`/`REMOTE_READER_TOKEN` env 覆盖。

产品/使用/设计文档：`docs/PRODUCT.md`、`docs/USER_GUIDE.md`、`docs/superpowers/specs/`（含 §15 实现现状）。**改动架构前必读 spec。**

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

根 `package.json` 提供 `bun run dev` / `bun run build` / `bun run test` 快捷方式（转发到 web workspace / vitest）。`bun run test` 经 vitest 的 node shebang 在 node 下跑（不用 bun 直接跑）。

```bash
bun install                                    # 装所有 workspace 依赖
bun run dev                                    # = bun --filter remote-reader-web dev（SvelteKit dev，http://localhost:5173）
bun run build                                  # = bun --filter remote-reader-web build（adapter-node 产物 → apps/web/build/）
bun --filter remote-reader-web check           # svelte-check 类型检查（src + .svelte）
bun --filter remote-reader-web db:generate     # 生成 Drizzle migration
bun --filter remote-reader-web db:migrate      # mkdir data + 执行 migration（含已生成 schema）
bun --filter remote-reader-mcp-bridge check    # 桥 tsc --noEmit 类型检查
bun run test                                   # 跑所有测试（vitest，node 运行时，fileParallelism:false）
bun run test apps/web/tests/auth.test.ts       # 跑单个测试文件
bun run test -t "测试名片段"                    # 按测试名过滤
```

> **运行时分工（已验证）**：`better-sqlite3` 是原生 addon，**bun 直接运行时（`bun -e`/`bun run *.ts`）加载失败**（oven-sh/bun#4290），但 `bun + vite dev` 下可加载。因此：测试用 **vitest**（`bun run test`，经 vitest 的 node shebang 在 node 下跑）；dev/build 用 bun；**生产用 `node apps/web/build/index.js`**（adapter-node 产物，勿用 `bun run` 启服务；入口是 index.js 不是 handler.js）。

⚠️ **部署注意**：用 `adapter-node` 产物 + **`node apps/web/build/index.js`** 启动（不要 `bun run` 启服务，会触发 better-sqlite3 加载失败），**不要用 `bun build --compile`** 打单二进制（oven-sh/bun#15734 已知不兼容，详见 spec §10）。生产必填 `SESSION_SECRET`（缺失 fail-fast）；`BODY_SIZE_LIMIT` 必须是字节数（数字，须 > `MAX_UPLOAD_BYTES`）。

## 运维 / 部署辅助脚本

```bash
node scripts/seed-token.mjs <email>            # 免 UI 直接为某用户生成一个 API token（直写 SQLite，明文打印一次）
API_TOKEN=rr_xxx BASE_URL=http://localhost:5173 bash scripts/e2e-check.sh   # 端到端冒烟：上传 → /s/<token> 200 → 错误场景
docker compose up --build                      # 一键起服务（:3000），data/ 挂载为卷
```

**Docker 非 root 运行**：`docker-entrypoint.sh` 先 `chown -R node:node /app/data`（host 首次建卷常是 root 属主），再用 `runuser -u node` 降权跑 `node apps/web/build/index.js`；healthcheck 命中 `/api/health`（含 DB `SELECT 1`，DB/磁盘故障返回 503）。改 entrypoint / Dockerfile 前看 sub3 设计 spec。

## 环境变量（完整清单见 `.env.example`）

核心：`DATABASE_PATH`、`DATA_DIR`、`BASE_URL`、`SESSION_SECRET`（生产必填，缺失 fail-fast）、`INITIAL_INVITE_CODE`（注册首个管理员所需）、`MAX_UPLOAD_BYTES`。运行时数据在 `data/`（已 gitignore，**绝不入库**）。

速率限制 / 会话 / 网关：`RATE_LIMIT_MAX` + `RATE_LIMIT_WINDOW_MS`（每 token 上传）、`LOGIN_RATE_LIMIT_MAX`（每邮箱登录）、`SESSION_MAX_AGE`（session 有效期秒，默认 30 天）、`BODY_SIZE_LIMIT`（adapter-node 请求体字节数，须 > `MAX_UPLOAD_BYTES`）、`PORT`（生产端口，默认 3000）。

## 安全要点（项目特有）

- **路径穿越**：Agent 传的 path 必须经 `parsePath`（`packages/shared/src/paths.ts`）sanitize，禁 `..`/绝对路径/null byte
- **md XSS**：markdown-it 必须保持 `html:false`；渲染产物用 `{@html}` 输出（受信 HTML）
- **凭证**：API token 只存 sha256 哈希，明文仅生成时显示一次；密码用 argon2id
- **权限**：API 操作校验 `owner_id == token.user_id`；`/s/<token>` 凭 token 访问（设计如此，绕过 owner 检查）

## 文档指针

- 设计 spec（权威）：`docs/superpowers/specs/2026-07-18-remote-reader-design.md`
- 实现计划：`docs/superpowers/plans/`（按子计划编号）
