# Remote Reader · 用户使用手册

> [English](./USER_GUIDE.en.md) | 中文

本手册按角色组织：**部署者 / 管理员**、**Agent 操作者**、**阅读者**。按需跳读。

> 状态：子计划 1（Web 核心）+ 子计划 2（本地 MCP 桥）+ 子计划 3（管理 UI + Markdown 增强 + Docker）**全部已实现并 merge master**。完整部署步骤见 [安装指导](./INSTALL.md)。

---

## 0. 快速上手（5 分钟本地体验）

```bash
git clone <repo> && cd remote_reader
cp .env.example .env            # 至少改 SESSION_SECRET、INITIAL_INVITE_CODE
```

**方式一：Docker（推荐）**

```bash
docker compose up -d --build    # → http://localhost:3000
```

**方式二：本地 dev**

```bash
bun install
bun --filter remote-reader-web db:migrate   # 生成 data/app.db
bun --filter remote-reader-web dev          # http://localhost:5173（被占会切 5174）
```

注册首个用户并上传一篇文档：

```bash
# 1) 浏览器打开 /register，用 .env 里的 INITIAL_INVITE_CODE 注册（首个用户自动成为 admin）

# 2) 为该用户生成 API token（二选一）
#    - UI：登录 → 设置 → API Token → 新建（明文仅显示一次）
#    - 脚本（仓库根目录）：
node scripts/seed-token.mjs your@email.com
# 输出：TOKEN=rr_xxxxxxxx...   ← 只显示一次，立即保存

# 3) 上传一篇 markdown
TOKEN="rr_xxxxxxxx..."
curl -X POST http://localhost:3000/api/v1/documents \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"hello.md","content":"# 你好\n\n这是 **Remote Reader**。\n\n```ts\nconst x: number = 1;\n```","path":"demo"}'
# 返回 {"id":"...","url":"http://localhost:3000/s/<token>"}

# 4) 打开返回的 url —— 免登录，直接看到渲染（标题/加粗/代码高亮）
```

---

## 1. 部署者 / 管理员

完整部署（Docker / 手动 node / 反向代理 / HTTPS / 备份 / 升级迁移）见 [安装指导](./INSTALL.md)。本节聚焦管理员日常操作。

### 1.1 注册首个管理员

启动后访问 `/register`，用 `INITIAL_INVITE_CODE` 注册——**第一个注册的用户自动成为 `admin`**。之后注册的用户为 `member`。`INITIAL_INVITE_CODE` 建议注册完首批用户后轮换。

### 1.2 API token 管理 ✅

**UI**（推荐）：登录 → 设置 → API Token。可新建（明文一次性 reveal，可复制）、撤销。撤销后该 token 立即失效。

**脚本**：

```bash
node scripts/seed-token.mjs <已注册用户的 email>     # 必须在仓库根目录执行
# → TOKEN=rr_...（明文只显示一次）
```

token 在数据库里只存 sha256 哈希，**明文丢失只能重新生成**。

### 1.3 数据库迁移

schema 变更后重新生成并执行 migration：

```bash
bun --filter remote-reader-web db:generate   # 生成新 migration SQL
bun --filter remote-reader-web db:migrate    # 应用（生产部署前在停服或维护窗口执行）
```

Docker 部署：migration 在镜像构建期已执行；schema 变更需重建镜像（`docker compose up -d --build`）。

---

## 2. Agent 操作者

### 2.1 推荐：本地 MCP 桥 ✅

桥（`apps/mcp-bridge`）是 stdio MCP server，暴露 `upload_document` 工具，本地持有 token 转发到 Web API。Agent 无需手写 HTTP。桥无原生依赖，`bun apps/mcp-bridge/src/index.ts` 直跑。

两种配置（env 优先于文件）：

**方式一：环境变量**（推荐，配合 MCP client 一次性传入）

```bash
claude mcp add remote-reader bun apps/mcp-bridge/src/index.ts \
  -e REMOTE_READER_URL=https://your-host \
  -e REMOTE_READER_TOKEN=rr_xxx
```

**方式二：配置文件**

写 `~/.config/remote-reader/config.json`（或 `$XDG_CONFIG_HOME/remote-reader/config.json`）：

```json
{ "baseUrl": "https://your-host", "token": "rr_xxx" }
```

然后只注册命令：`claude mcp add remote-reader bun apps/mcp-bridge/src/index.ts`。

配置缺失（既无 env 又无文件）桥启动即退（exit 1）并打印指引。配置好后，Agent 调用 `upload_document({ name, content, path? })`，拿到 `已上传（id=...）。查看链接：https://.../s/<token>` 的工具结果。

> 调试：`npx @modelcontextprotocol/inspector bun apps/mcp-bridge/src/index.ts`，或 `bun apps/mcp-bridge/scripts/smoke-client.ts <url> <token>`（需 Web 应用在跑）。

### 2.2 备选：直接调 HTTP API ✅

不用桥时可直接调用上传 API：

```
POST /api/v1/documents
Header: Authorization: Bearer <API_TOKEN>
        Content-Type: application/json
Body:   { "name": "<文件名>", "content": "<markdown 正文>", "path": "<可选目录路径>" }

Response 200: { "id": "...", "url": "https://<host>/s/<share-token>" }
```

**参数**：

- `name`（必填）：文件名，如 `weekly.md`。经路径安全过滤（禁 `..` / 绝对路径 / `\` / `:` 等）。
- `content`（必填）：markdown 正文（UTF-8 字符串）。
- `path`（可选）：POSIX 风格目录前缀，如 `reports/2026-07`。同样过滤。

### 2.3 幂等语义（重要）

按 `(owner, path, name)` 定位文档，按 content 的 sha256 判断：

| 情况 | 行为 | 返回 |
|---|---|---|
| 该位置无文档 | 新建 + 落盘 + 生成 share link | `{ id, url }`（新） |
| 有，内容相同 | **不写盘、不改时间戳** | `{ id, url }`（同） |
| 有，内容不同 | 覆盖磁盘 + 更新 hash/size | `{ id, url }`（**id 与 url 不变**） |

→ **同一份文档的查看链接长期稳定**；内容更新后链接不变、自动指向最新版本。Agent 可放心重复上传。

### 2.4 错误码

| HTTP | 含义 | 处理 |
|---|---|---|
| 200 | 上传成功 | 把 `url` 发给用户 |
| 400 | 请求体非法 / JSON 解析失败 / `name` 或 `path` 含非法字符（含 `..` 穿越） | 修正参数重试，**不要**当服务器故障重试 |
| 401 | 缺 token 或 token 无效/已撤销 | 检查 `Authorization: Bearer` |
| 413 | 内容超 `MAX_UPLOAD_BYTES`（默认 5MB） | 拆分或精简文档 |
| 429 | 触发速率限制（每 token 默认 60/min） | 退避后重试 |

---

## 3. 阅读者

### 3.1 查看分享文档 ✅

收到 Agent 发来的链接（形如 `https://<host>/s/<token>`），**直接点击**——无需注册、登录，立刻看到渲染好的文档（标题、加粗、列表、GFM 表格、Shiki 代码高亮、Mermaid 流程图、KaTeX 公式）。链接可反复访问，内容随 Agent 更新自动刷新（同一链接指向最新版本）。

### 3.2 自行管理文档 ✅

想浏览 / 删除 / 整理自己的文档库：访问站点首页 → 登录 → **文件管理器**（双栏：左树右列表）：

- 目录树浏览、新建文件夹、移动（含环路检测）、重命名、删除（级联删除子孙 + 磁盘文件 + share links）；
- 进入任意文档的 owner 查看页 `/d/<id>`；
- 设置 → **分享链接**：查看 / 撤销分享（撤销后 `/s/<token>` 立即 404）；
- 设置 → **API Token**：创建 / 撤销。

---

## 4. 配置参考（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SESSION_SECRET` | （无，生产必填） | session 签名密钥；生产缺失 fail-fast，dev 缺失用不安全默认并告警 |
| `INITIAL_INVITE_CODE` | （无） | 注册所需邀请码 |
| `DATABASE_PATH` | `./data/app.db` | SQLite 路径（相对运行时 cwd） |
| `DATA_DIR` | `./data/documents` | 文档落盘根目录 |
| `BASE_URL` | `http://localhost:5173` | 生成分享链接的外链前缀 |
| `MAX_UPLOAD_BYTES` | `5242880`（5MB） | 单文档大小上限 |
| `BODY_SIZE_LIMIT` | adapter-node 默认 512K | **字节数（数字）**，网关层 body 上限，须 > `MAX_UPLOAD_BYTES` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `60` / `60000` | 每 token 上传速率 |
| `LOGIN_RATE_LIMIT_MAX` | `10` | 每邮箱登录尝试次数（同窗口） |
| `SESSION_MAX_AGE` | `2592000`（30 天，秒） | session 有效期；token 内嵌 exp 服务端校验 |
| `PORT` / `HOST` / `ORIGIN` | `3000` / `0.0.0.0` / — | adapter-node 监听与 origin 校验 |
| `NODE_ENV` | — | 设 `production` 启用安全 cookie + 强制 SESSION_SECRET |

> 数值型变量用 `envInt` 严格解析：非正整数会在模块加载时抛错（fail-closed），不静默退化。

---

## 5. 故障排查

| 现象 | 排查 |
|---|---|
| 生产启动报 `SESSION_SECRET must be set in production` | 设置 `SESSION_SECRET`（长随机串） |
| 生产启动报 `Invalid BODY_SIZE_LIMIT` | 改成字节数（如 `8388608`），不带单位 |
| `better-sqlite3 ... not supported` / `ERR_DLOPEN_FAILED` | 你在用 `bun run` 启服务——改用 `node apps/web/build/index.js` |
| `bun run test` 报 better-sqlite3 加载失败 | 不应使用 `bun test`；测试用 vitest，跑 `bun run test`（经 node） |
| 上传 >512K 返回 413 但你确定 < `MAX_UPLOAD_BYTES` | `BODY_SIZE_LIMIT` < 内容大小（adapter-node 默认仅 512K） |
| 注册时邀请码无效 | 核对 `INITIAL_INVITE_CODE` 与启动时一致 |
| seed-token 报 `Cannot find package 'better-sqlite3'` | 在**仓库根目录**执行（非 apps/web） |
| Docker 容器 `unhealthy` | `docker compose logs web`；常见是端口/配置/env 缺失 |
| 链接打不开 / 404 | share token 失效或文档被删；让 Agent 重新上传 |
| 端口 5173 被占 | dev 自动切 5174；或改 `--port` |

---

## 6. 安全注意事项

- **API token 是上传凭证**，明文只生成时显示一次，妥善保管；怀疑泄露立即（UI 一键或手动）撤销并重新生成。
- **分享链接 = 公开钥匙**：任何持有 `/s/<token>` 的人都能读该文档。不要发到公开渠道；owner 可在「分享链接」页撤销。
- 生产**必须 HTTPS**（session cookie 的 `secure` 标志依赖它）。
- `data/` 含数据库与文档，**绝不入库**（已 gitignore），按机密资料备份与保护。
- 上传的 `name` / `path` 已做路径安全过滤，但仍建议 Agent 传规范 POSIX 路径，避免无谓的 400。

---

## 相关文档

- [安装指导](./INSTALL.md) —— Docker / 手动部署 / 反向代理 / 备份升级 / 配置参考
- [产品概览](./PRODUCT.md) —— 定位、场景、功能、路线图
- [设计文档](./superpowers/specs/2026-07-18-remote-reader-design.md) —— 架构、数据模型、安全模型、实现现状
- 快速上手：根目录 [`README.md`](../README.md)
