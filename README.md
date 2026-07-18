# Remote Reader

让远程 Agent 通过 MCP 把 Markdown 文档交付给用户在浏览器阅读。

核心流程：Agent 上传文档 → 拿到免登录查看链接 → 通过 IM 发给用户 → 用户点链接一步看到渲染结果。

## 当前状态

子计划 1（Web 应用核心）已完成：Token 认证上传 API + 免登录 markdown 查看页。
本地 MCP 桥（子计划 2）、文件管理器 UI + Docker（子计划 3）尚未实现。

## 技术栈

TypeScript · Bun（包管理 + dev/build 宿主） · SvelteKit（全栈 SSR） · Drizzle ORM + SQLite（better-sqlite3） · markdown-it + Shiki · @node-rs/argon2 · vitest。

> **运行时分工**：`better-sqlite3` 是原生 addon，bun 直接运行时加载失败（仅 `bun + vite dev` 下可用）。因此：**测试用 `bun run test`（vitest，在 node 下跑）**；dev/build/install 用 bun；**生产用 `node build/handler.js`**（adapter-node 产物，勿用 `bun run` 启服务）。

## 快速开始

```bash
cp .env.example .env          # 填好 SESSION_SECRET / INITIAL_INVITE_CODE
bun install
bun --filter remote-reader-web db:migrate   # 执行 migration（生成 data/app.db）
bun --filter remote-reader-web dev          # http://localhost:5173（被占会切 5174）
```

1. 访问 `/register`，用邀请码注册（首个用户自动成为 admin）。
2. 生成 API token：`node scripts/seed-token.mjs <your-email>`（仅显示一次，立即保存）。
3. 上传文档：
   ```bash
   curl -X POST http://localhost:5173/api/v1/documents \
     -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
     -d '{"name":"hello.md","content":"# Hi","path":"demo"}'
   ```
4. 打开返回的 `url`（形如 `/s/<token>`）直接查看——**免登录**，渲染 markdown + Shiki 代码高亮 + GFM 表格。

## 上传语义（幂等）

按 `(owner, path, name)` 定位文档，按 content sha256 判断：
- 不存在 → 新建 + 落盘 + 生成 share link，返回 `{id, url}`。
- 存在且内容相同 → 不写盘、不改时间戳，返回同一 `{id, url}`。
- 存在且内容不同 → 覆盖磁盘、更新 hash/size，**id 与 share url 不变**（链接长期有效，自动指向最新内容）。

## 生产部署

```bash
bun --filter remote-reader-web build
DATABASE_PATH=./data/app.db DATA_DIR=./data/documents \
  BASE_URL=https://your-host SESSION_SECRET=... node build/handler.js
```
⚠️ 用 `node` 启动，**不要 `bun run`**（better-sqlite3 在 bun 直接运行时加载失败）。

## 测试

```bash
bun run test                                  # 全部单测（vitest，node 运行时）
bun run test apps/web/tests/documents.test.ts # 单个文件
bun run test -t "测试名片段"                   # 按名过滤
bun --filter remote-reader-web check          # svelte-check 类型检查
```

## 端到端检查

另开终端起 dev，再跑：

```bash
TOKEN=$(node scripts/seed-token.mjs <email> | sed 's/^TOKEN=//')
API_TOKEN=$TOKEN BASE_URL=http://localhost:5174 ./scripts/e2e-check.sh
```

预期输出 `✓ 子计划 1 端到端通过`。
