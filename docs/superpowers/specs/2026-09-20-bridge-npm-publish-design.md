# remote-reader-bridge npm 包发布设计

> 日期：2026-09-20 · 状态：设计定稿（待实现）

## 1. 背景与目标

登录页 Agent 指引的「方式一：bunx remote-reader-bridge」目前是预留文案（npm 包不存在，Agent 试跑失败一次后回落 clone）。目标：把桥发布为 npm 包 **`remote-reader-bridge`**（registry 已确认未占用），让 `npx/bunx remote-reader-bridge` 一键可用——无需 clone 仓库、无需 bun（node ≥18 即可），并配 GitHub Actions tag 触发自动发布（`NPM_TOKEN` secret 已在仓库配置）。

## 2. 方案（已裁定）

**单文件零依赖 bundle**（esbuild）：把 `src/index.ts` 连同 `@remote-reader/shared` 与 `@modelcontextprotocol/sdk` 全部内联为 `dist/index.js`（ESM + `#!/usr/bin/env node` banner，platform=node，target=node18）。发布产物只有 `dist/` + `README.md`，运行时依赖为空。

- 不发双包（`@remote-reader/shared` 需拥有 npm scope，双包版本联动复杂度×2）
- 仓库内 dev 流程零变化（仍 `bun src/index.ts` 直跑 + tsc check + vitest）

## 3. 包改造（apps/mcp-bridge）

- `package.json`：`name` 改 `remote-reader-bridge`（workspace 内无任何依赖方引用旧名，根 scripts 只 filter web；AGENTS.md 两处 `--filter remote-reader-mcp-bridge` 文档引用同步改）；`version: 0.1.0`；`private: true` 移除；新增：
  - `"bin": { "remote-reader-bridge": "dist/index.js" }`
  - `"files": ["dist", "README.md"]`
  - `"engines": { "node": ">=18" }`
  - `"publishConfig": { "access": "public" }`
  - scripts 增 `"build": "esbuild src/index.ts --bundle --platform=node --target=node18 --format=esm --outfile=dist/index.js --banner:js=\"#!/usr/bin/env node\""`
  - devDependencies 增 `esbuild`
- `.gitignore` 增 `apps/mcp-bridge/dist`
- 新增 `apps/mcp-bridge/README.md`（npm 落地页）：是什么（Remote Reader 本地 MCP 桥）、两个配置方式（`~/.config/remote-reader/config.json` 或 `REMOTE_READER_URL`/`REMOTE_READER_TOKEN` env）、MCP 注册示例（`claude mcp add` + mcpServers JSON）、指回仓库文档
- esbuild 细节：ESM 输出下 MCP SDK 若含动态 import 由 esbuild 自动保留（构建后冒烟实测兜底）；`node:` 内建自动 external

## 4. 发布流水线（.github/workflows/publish-bridge.yml，仓库首个 workflow）

```yaml
name: publish-bridge
on:
  push:
    tags: ['bridge-v*']

jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install --frozen-lockfile
      - run: bun --filter remote-reader-bridge check
      - run: bun --filter remote-reader-bridge build
      - name: 版本一致性守卫（tag 版本必须等于 package.json 版本）
        run: |
          PKG_VERSION=$(node -p "require('./apps/mcp-bridge/package.json').version")
          TAG_VERSION="${GITHUB_REF_NAME#bridge-v}"
          [ "$PKG_VERSION" = "$TAG_VERSION" ] || { echo "version mismatch: pkg=$PKG_VERSION tag=$TAG_VERSION"; exit 1; }
      - uses: actions/setup-node@v4
        with: { node-version: 22, registry-url: 'https://registry.npmjs.org' }
      - run: npm publish
        working-directory: apps/mcp-bridge
        env:
          NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

## 5. 指引与文档更新（发布验证通过后即成立，同一批交付）

- **登录页指引块**（`login/+page.svelte`）：方式一去掉「如已发布」→「方式一（npm 包，推荐）：`bunx remote-reader-bridge`（或 `npx remote-reader-bridge`）」；步骤 5 补 npm 路线注册示例：`claude mcp add remote-reader -- npx -y remote-reader-bridge -e REMOTE_READER_URL=... -e REMOTE_READER_TOKEN=...` 与 mcpServers JSON 变体（command 用 `npx`/`bunx`，无绝对路径负担——绝对路径警告仅适用 clone 路线）
- `README.md`/`README.en.md`「通过 MCP 上传」节：补 npm 安装为先选，clone 为备选
- `docs/USER_GUIDE.md`/`.en.md` §2.0/§2.1：同步两种装桥方式
- `AGENTS.md`：桥运行时段补 npm 分发事实 + 发版 SOP
- 本 spec §7 即 SOP

## 6. 验证计划

1. **本地构建冒烟**：`bun --filter remote-reader-bridge build` → 用 **node**（非 bun）拉起 `dist/index.js`（env 注入配置），对真实 dev server 跑 `upload_document` 全链路（复用 `scripts/smoke-client.ts` 思路，临时改 command/args 或参数化）
2. `npm pack --dry-run`：核对产物只含 dist/README.md、bin 正确
3. 推 tag 后：GitHub Actions run 绿 + `npm view remote-reader-bridge version` 返回 0.1.0
4. **发布后实测**：`npx -y remote-reader-bridge`（node 环境）对 dev server 全链路

## 7. 发版 SOP（后续版本）

1. 改 `apps/mcp-bridge/package.json` version → commit
2. `git tag bridge-v<version> && git push origin bridge-v<version>`
3. 流水线自动发布；`npm view` 验证

## 8. 范围外（YAGNI）

- npm provenance / trusted publishing（需额外 npm/GitHub 配置）
- changesets 语义化发版自动化（单包手动 tag 足够）
- `@remote-reader/shared` 独立发布
- web 应用 Docker 镜像发布 GHCR
