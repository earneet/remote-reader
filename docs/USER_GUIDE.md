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
# 返回 {"id":"...","url":"http://localhost:3000/s/<token>"}（若检测到未上传的本地图片引用，
# 另含 "warnings": ["..."] 提示；响应头 X-Remote-Reader-Min-Bridge 下发建议的最低桥版本）

# 4) 打开返回的 url —— 免登录，直接看到渲染（标题/加粗/代码高亮）
```

---

## 1. 部署者 / 管理员

完整部署（systemd 一键 / Docker / 手动 node / 反向代理 / HTTPS / 备份 / 升级迁移）见 [安装指导](./INSTALL.md)。本节聚焦管理员日常操作。

### 1.1 注册首个管理员

启动后访问 `/register`，用 `INITIAL_INVITE_CODE` 注册——**第一个注册的用户自动成为 `admin`**。之后注册的用户为 `member`。

首个 admin 就位后，可在 `/settings/invites`（admin 专属）生成 DB 邀请码邀请他人注册：生成时选有效期（1/7/30 天），有效期内可多次使用，可随时撤销；明文仅生成时显示一次。`INITIAL_INVITE_CODE` 为引导码，长期有效，建议注册完首批用户后轮换或改用 DB 邀请码。

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

### 2.0 Agent 自助接入（零手工，推荐）

把这句话发给你的 Agent（替换邀请码）：

> 请访问 https://your-host，页面里的「Agent 自动接入指南」会指导你完成 MCP 桥安装与账号注册；使用邀请码 ri_xxx 注册，邮箱密码由你与我商量决定。

Agent 读取登录页 SSR HTML 中的 `<details id="agent-guide">` 指引块（对人默认折叠、对 Agent 始终可见），自动执行：

1. 安装桥：`npx -y remote-reader-bridge` / `bunx remote-reader-bridge`（npm 包，推荐，node ≥18 无需克隆）或 `git clone <BRIDGE_REPO_URL> && bun install`（源码）
2. `POST /api/v1/auth/register`（邀请码 + 邮箱 + 密码；已有账号用 `POST /api/v1/auth/login`）→ 种 session cookie
3. `POST /api/v1/auth/api-token`（带 session cookie）→ 一次性返回 `rr_` token
4. 写 `~/.config/remote-reader/config.json` → 注册 MCP server（npm 路线 `claude mcp add remote-reader -- npx -y remote-reader-bridge`，无需绝对路径）

错误形状统一 `{"message":"..."}`：403 邀请码无效 / 409 邮箱已注册 / 429 限流 / 401 session 失效。

### 2.1 推荐：本地 MCP 桥 ✅

桥（`apps/mcp-bridge`）是 stdio MCP server，暴露 `upload_document` 工具，本地持有 token 转发到 Web API。Agent 无需手写 HTTP。

**安装（二选一）**：

- **npm 包（推荐）**：`npx -y remote-reader-bridge` / `bunx remote-reader-bridge`（node ≥18，无需 bun 与克隆）。写了配置文件后注册只要一行：`claude mcp add remote-reader -- npx -y remote-reader-bridge`
- **源码**：`git clone` 本仓库 + `bun install`，桥无原生依赖可直跑。**注册进 MCP 客户端时源码入口必须写绝对路径**——客户端拉起 stdio 进程的工作目录没有保证，相对路径会间歇性 `Module not found`（典型症状：工具能用但状态页显示 failed）。

两种配置（env 优先于文件）：

**方式一：环境变量**（推荐，配合 MCP client 一次性传入）

```bash
# 在仓库根目录执行，$(pwd) 在注册时展开为绝对路径（Windows PowerShell 用 "$PWD/..."）
claude mcp add remote-reader bun "$(pwd)/apps/mcp-bridge/src/index.ts" \
  -e REMOTE_READER_URL=https://your-host \
  -e REMOTE_READER_TOKEN=rr_xxx
```

**方式二：配置文件**

写 `~/.config/remote-reader/config.json`（或 `$XDG_CONFIG_HOME/remote-reader/config.json`）：

```json
{ "baseUrl": "https://your-host", "token": "rr_xxx" }
```

然后只注册命令：`claude mcp add remote-reader bun "$(pwd)/apps/mcp-bridge/src/index.ts"`。

**其他 MCP 客户端**（Cursor / Cline / Windsurf / opencode / ZCode 等直接读配置文件的）：用标准 `mcpServers` JSON，入口同样写绝对路径（ZCode 放在 `~/.zcode/cli/config.json` 的 `mcp.servers` 下，字段含义相同）：

```json
{
  "mcpServers": {
    "remote-reader": {
      "command": "bun",
      "args": ["/absolute/path/to/remote-reader/apps/mcp-bridge/src/index.ts"],
      "env": { "REMOTE_READER_URL": "https://your-host", "REMOTE_READER_TOKEN": "rr_xxx" }
    }
  }
}
```

配置缺失（既无 env 又无文件）桥启动即退（exit 1）并打印指引。配置好后，Agent 调用 `upload_document({ name, content, path? })`，拿到 `已上传（id=...）。查看链接：https://.../s/<token>` 的工具结果。

> 调试：`npx @modelcontextprotocol/inspector bun apps/mcp-bridge/src/index.ts`，或 `bun apps/mcp-bridge/scripts/smoke-client.ts <url> <token>`（需 Web 应用在跑）。

### 2.2 带图文档：本地图片自动上传 ✅

`content` 里的**本地图片引用**会被自动上传并改写，Agent 无需额外参数：

```markdown
# 周报
![架构图](./assets/arch.png)   ← 相对路径按桥工作目录解析，自动上传
![外链图](https://cdn.example.com/x.png) ← 外链不动，原样保留
```

**规则与限制**：

- **路径解析**：`![alt](路径)` 中的相对路径按桥进程工作目录解析（含 Windows 盘符绝对路径）；外链（`http(s)://`）、`data:` URI、含 `/` `\` 的多段路径**不视为本地图**，原样保留。
- **格式**：支持 png / jpeg / gif / webp（魔数检测，扩展名须与真实格式一致——`.png` 里装 JPEG 会被拒）。**SVG 不支持**（可携带脚本，安全考虑），改用 png/webp 导出。
- **大小**：单图 ≤ `MAX_IMAGE_BYTES`（默认 10MB，init 预检 + relay 实测双重校验）；单文档建议 ≤50 张图（服务端限流约束，超量会被 429 限流）。
- **去重与回收**：图片按 sha256 内容寻址，同字节的图全库只存一份（重传直接复用）；图片一旦不被任何文档引用即自动回收（覆盖更新去掉引用 / 删除文档后），无需手动清理。
- **预检**：上传前一次性列出全部问题（文件不存在 / 格式不支持 / 超大），不会传一半才失败。

走 MCP 桥时以上全自动；直接调 HTTP API 时需自行编排三端点：

| 端点 | 作用 | 返回 |
|---|---|---|
| `POST /api/v1/images/init` | 按 `{name, content_hash, content_md5, size_bytes}` 登记/查询 | `{status:"relay"\|"exists"\|"direct", name, imageId?}` |
| `POST /api/v1/images` | relay 中转字节 `{image_id, content_base64}`（hash 绑定校验） | `{name}` |
| `POST /api/v1/images/confirm` | s3 直传后确认 `{image_id}`（ETag/魔数校验） | `{status:"ok", name}` |

上传 md 时 `content` 用 init/relay 返回的**注册名**裸引用（如 `![截图](shot.png)`），服务端登记引用关系（refs）——只有被引用的图才对查看页可见（refs 白名单，防 share token 枚举 owner 其他图）。

### 2.3 备选：直接调 HTTP API ✅

不用桥时可直接调用上传 API：

```
POST /api/v1/documents
Header: Authorization: Bearer <API_TOKEN>
        Content-Type: application/json
Body:   { "name": "<文件名>", "content": "<markdown 正文>", "path": "<可选目录路径>" }

Response 200: { "id": "...", "url": "https://<host>/s/<share-token>" }
```

条件字段 `warnings?: string[]`：检测到本地图片引用未随文档上传（通常是桥版本过旧）时出现，Agent 应按提示升级桥后重新上传；成功响应均带 `X-Remote-Reader-Min-Bridge` 头，下发建议的最低桥版本。

**参数**：

- `name`（必填）：文件名，如 `weekly.md`。经路径安全过滤（禁 `..` / 绝对路径 / `\` / `:` 等）。
- `content`（必填）：markdown 正文（UTF-8 字符串）。
- `path`（可选）：POSIX 风格目录前缀，如 `reports/2026-07`。同样过滤。

### 2.4 幂等语义（重要）

按 `(owner, path, name)` 定位文档，按 content 的 sha256 判断：

| 情况 | 行为 | 返回 |
|---|---|---|
| 该位置无文档 | 新建 + 落盘 + 生成 share link | `{ id, url }`（新） |
| 有，内容相同 | **不写盘、不改时间戳** | `{ id, url }`（同） |
| 有，内容不同 | 覆盖磁盘 + 更新 hash/size | `{ id, url }`（**id 与 url 不变**） |

> 三种情况返回恒为 `{ id, url }`；`warnings?: string[]` 为条件字段（检测到未上传的本地图片引用时出现，见 §2.3）。

→ **同一份文档的查看链接长期稳定**；内容更新后链接不变、自动指向最新版本。Agent 可放心重复上传。

### 2.5 错误码

| HTTP | 含义 | 处理 |
|---|---|---|
| 200 | 上传成功 | 把 `url` 发给用户 |
| 400 | 请求体非法 / JSON 解析失败 / `name` 或 `path` 含非法字符（含 `..` 穿越） | 修正参数重试，**不要**当服务器故障重试 |
| 401 | 缺 token 或 token 无效/已撤销 | 检查 `Authorization: Bearer` |
| 413 | 内容超 `MAX_UPLOAD_BYTES`（默认 5MB）/ 图片超 `MAX_IMAGE_BYTES`（默认 10MB） | 拆分或精简文档 |
| 429 | 触发速率限制（文档上传每 token 默认 60/min；图片中转独立同额；init/confirm 轻桶默认 120/min） | 退避后重试 |

---

## 3. 阅读者

### 3.1 查看分享文档 ✅

收到 Agent 发来的链接（形如 `https://<host>/s/<token>`），**直接点击**——无需注册、登录，立刻看到渲染好的文档（标题、加粗、列表、GFM 表格、Shiki 代码高亮、Mermaid 流程图、KaTeX 公式）。链接可反复访问，内容随 Agent 更新自动刷新（同一链接指向最新版本）。

文档内的图片直接随页面渲染（免登录）。**点击任意图片**打开 Lightbox 图集查看器：滚轮/pinch 缩放（0.2–10x）、放大后拖动平移、双击快速放大/还原、`←`/`→` 切换图集内其他图片、`⛶` 全屏、`Esc` 或 `✕` 关闭。

### 3.2 自行管理文档 ✅

想浏览 / 删除 / 整理自己的文档库：访问站点首页 → 登录 → **文件管理器**（双栏：左树右列表）：

- 目录树浏览、新建文件夹、移动（含环路检测）、重命名、删除（级联删除子孙 + 磁盘文件 + share links）；
- 行首图标区分**私有 / 已共享**（共享 = 存在有效分享链接）；行尾 ⋯ 菜单（桌面下拉 / 移动底部菜单）集中全部行操作，含**复制分享链接**（私有文档点它即生成链接并转为共享）与**转为私有**（一键撤销该文档全部链接，确认后不可恢复）；
- 进入任意文档的 owner 查看页 `/d/<id>`；
- 设置 → **分享链接**：查看 / 撤销分享（撤销后 `/s/<token>` 立即 404）；
- 设置 → **API Token**：创建 / 撤销。

---

## 4. 配置参考（环境变量）

| 变量 | 默认 | 说明 |
|---|---|---|
| `SESSION_SECRET` | （无，生产必填） | session 签名密钥；生产缺失 fail-fast，dev 缺失用不安全默认并告警 |
| `INITIAL_INVITE_CODE` | （无） | 引导邀请码：注册首个 admin 所必需，长期有效；此后可用 `/settings/invites` 的 DB 邀请码 |
| `DATABASE_PATH` | `./data/app.db` | SQLite 路径（相对运行时 cwd） |
| `DATA_DIR` | `./data/documents` | 文档落盘根目录 |
| `BASE_URL` | `http://localhost:5173` | 生成分享链接的外链前缀 |
| `BRIDGE_REPO_URL` | `https://github.com/earneet/remote-reader` | 登录页 Agent 指引块展示的桥源码克隆地址（自定义 fork 时修改） |
| `MAX_UPLOAD_BYTES` | `5242880`（5MB） | 单文档大小上限 |
| `BODY_SIZE_LIMIT` | adapter-node 默认 512K | **字节数（数字）**，网关层 body 上限，须 > `MAX_UPLOAD_BYTES` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `60` / `60000` | 每 token 上传速率 |
| `LOGIN_RATE_LIMIT_MAX` | `10` | 每邮箱登录尝试次数（同窗口） |
| `SESSION_MAX_AGE` | `2592000`（30 天，秒） | session 有效期；token 内嵌 exp 服务端校验 |
| `PORT` / `HOST` / `ORIGIN` | `3000` / `0.0.0.0` / — | adapter-node 监听与 origin 校验 |
| `NODE_ENV` | — | 设 `production` 启用安全 cookie + 强制 SESSION_SECRET |
| `OBJECT_STORE_ENDPOINT` 等 5 项 | —（全空=关闭） | S3 兼容对象存储（七牛/R2/OSS 网关/MinIO 通接），冷热分层归档；5 项要么全填要么全空，缺一启动报错 |
| `COLD_TIER_AFTER_DAYS` | `30` | 冷判定阈值（天）：超期未访问未更新自动归档；冷文档点开自动回热，仍可看、标题可搜 |

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
| 注册时邀请码无效 | 引导码：核对 `INITIAL_INVITE_CODE` 与启动时一致；DB 码：可能已过期或被 admin 撤销（`/settings/invites` 查看） |
| seed-token 报 `Cannot find package 'better-sqlite3'` | 在**仓库根目录**执行（非 apps/web） |
| Docker 容器 `unhealthy` | `docker compose logs web`；常见是端口/配置/env 缺失 |
| 链接打不开 / 404 | share token 失效或文档被删；让 Agent 重新上传 |
| 端口 5173 被占 | dev 自动切 5174；或改 `--port` |

---

## 6. 安全注意事项

- **API token 是上传凭证**，明文只生成时显示一次，妥善保管；怀疑泄露立即（UI 一键或手动）撤销并重新生成。
- **分享链接 = 公开钥匙**：任何持有 `/s/<token>` 的人都能读该文档。不要发到公开渠道；owner 可在文件管理器行菜单「转为私有」一键全撤，或在「分享链接」页逐条撤销。
- 生产**必须 HTTPS**（session cookie 的 `secure` 标志依赖它）。
- `data/` 含数据库与文档，**绝不入库**（已 gitignore），按机密资料备份与保护。
- 上传的 `name` / `path` 已做路径安全过滤，但仍建议 Agent 传规范 POSIX 路径，避免无谓的 400。

---

## 相关文档

- [安装指导](./INSTALL.md) —— systemd 一键 / Docker / 手动部署 / 反向代理 / 备份升级 / 配置参考
- [产品概览](./PRODUCT.md) —— 定位、场景、功能、路线图
- [设计文档](./superpowers/specs/2026-07-18-remote-reader-design.md) —— 架构、数据模型、安全模型、实现现状
- 快速上手：根目录 [`README.md`](../README.md)
