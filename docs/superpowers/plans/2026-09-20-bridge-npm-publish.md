# remote-reader-bridge npm 发布 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 桥发布为 npm 包 `remote-reader-bridge`（单文件零依赖 bundle），GitHub Actions tag 触发自动发布，登录页指引方式一转正。

**Architecture:** esbuild 单文件 ESM bundle（内联 shared + MCP SDK）+ `bin` 入口 + node≥18；workflow `bridge-v*` tag 触发，含版本一致性守卫；发布后指引/文档去对冲。

**Spec:** `docs/superpowers/specs/2026-09-20-bridge-npm-publish-design.md`

---

### Task 1: 包改造 + 构建脚本

**Files:**
- Modify: `apps/mcp-bridge/package.json`（改名/bin/files/engines/publishConfig/build script/esbuild devDep）
- Modify: `.gitignore`（`apps/mcp-bridge/dist`）
- Create: `apps/mcp-bridge/README.md`（npm 落地页）
- Modify: `AGENTS.md`（两处 `--filter remote-reader-mcp-bridge` → `remote-reader-bridge`）

- [ ] Step 1: 重写 `apps/mcp-bridge/package.json`（name=`remote-reader-bridge`，去 private，version 0.1.0，bin/files/engines/publishConfig，scripts 增 build=esbuild bundle ESM+shebang，devDependencies 增 `esbuild: ^0.25.0`）
- [ ] Step 2: `bun install`（装 esbuild）→ `bun --filter remote-reader-bridge build` 产出 `dist/index.js`（首行 `#!/usr/bin/env node`）
- [ ] Step 3: `.gitignore` 加产物目录；写 `apps/mcp-bridge/README.md`（是什么/两配置/MCP 注册示例/指回仓库）
- [ ] Step 4: `bun --filter remote-reader-bridge check`（tsc 仍 0 错）+ AGENTS.md 改 `--filter` 引用
- [ ] Step 5: Commit `feat(bridge): npm 发布改造——remote-reader-bridge 单文件 bundle（bin/esbuild/落地页 README）`

### Task 2: node 冒烟 + 产物核对

**Files:**
- Modify: `apps/mcp-bridge/scripts/smoke-client.ts`（command/args 参数化：`SMOKE_COMMAND` 默认 `bun`、`SMOKE_ARGS` 默认 `apps/mcp-bridge/src/index.ts`，逗号分隔）

- [ ] Step 1: 参数化 smoke-client（StdioClientTransport 的 command/args 读 env）
- [ ] Step 2: tmux 起 dev server（独立端口/DB/邀请码），register+api-token 自举 token
- [ ] Step 3: `SMOKE_COMMAND=node SMOKE_ARGS=apps/mcp-bridge/dist/index.ts bun apps/mcp-bridge/scripts/smoke-client.ts <url> <token>` → 工具调用成功返回 url
- [ ] Step 4: `cd apps/mcp-bridge && npm pack --dry-run` → 产物仅 dist/README.md，bin 指向 dist/index.js
- [ ] Step 5: 清理 dev server；Commit `test(bridge): smoke-client 参数化 + node 产物冒烟`

### Task 3: 发布流水线

**Files:**
- Create: `.github/workflows/publish-bridge.yml`（spec §4 全文）

- [ ] Step 1: 写 workflow（tag bridge-v* 触发：install→check→build→版本守卫→setup-node→npm publish via NPM_TOKEN）
- [ ] Step 2: `actionlint` 或 YAML 语法核对（无 actionlint 则 node yaml 解析冒烟）
- [ ] Step 3: Commit `ci: publish-bridge workflow——tag 触发 npm 发布（版本守卫 + NPM_TOKEN）`

### Task 4: 指引与文档转正

**Files:**
- Modify: `apps/web/src/routes/login/+page.svelte`（方式一去「如已发布」、补 npx/bunx 注册示例）
- Modify: `README.md`/`README.en.md`、`docs/USER_GUIDE.md`/`.en.md`（npm 先选/clone 备选）
- Modify: `AGENTS.md`（桥运行时补 npm 分发 + 发版 SOP）、spec 无需改

- [ ] Step 1: 登录页指引更新（方式一推荐 bunx/npx；§5 补 npm 注册命令与 mcpServers JSON 变体；绝对路径警告限定 clone 路线）
- [ ] Step 2: README/USER_GUIDE 中英同步（「通过 MCP 上传」装桥两方式排序翻转）
- [ ] Step 3: AGENTS.md 桥运行时段补 npm 分发 + SOP 指针
- [ ] Step 4: `bun run test` + svelte-check 回归
- [ ] Step 5: Commit `docs: npm 包转正——登录页指引/README/USER_GUIDE 去对冲 + bunx/npx 注册示例（中英）`

### Task 5: 发布执行（需用户允许 push）

- [ ] Step 1: `git push origin master`
- [ ] Step 2: `git tag bridge-v0.1.0 && git push origin bridge-v0.1.0`
- [ ] Step 3: 等待 Actions run 绿（gh run watch 或轮询）
- [ ] Step 4: `npm view remote-reader-bridge version` → 0.1.0
- [ ] Step 5: `npx -y remote-reader-bridge` 对 dev server 全链路实测（需配置 env）
