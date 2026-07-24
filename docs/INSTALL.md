# 安装指导 · Remote Reader

> [English](./INSTALL.en.md) | 中文

本文涵盖从零部署到生产运维的全流程。三种部署方式按需选择，按角色跳读：快速跑起来看 §1–§3；生产加固看 §6–§8。

---

## 部署方式速选

| 方式 | 适合场景 | 依赖 | 推荐度 |
|---|---|---|---|
| **[方式一](#2-方式一systemd-一键安装最简) · systemd 一键安装** | 单机 / VPS、不想用 Docker、要系统级守护 | Ubuntu/Debian + node 22+ + bun | ★★★★★ 最快上手 |
| **[方式二](#3-方式二docker-compose推荐生产) · Docker Compose** | 已用 Docker / 要隔离 / 多实例 | Docker + Docker Compose | ★★★★★ 隔离最干净 |
| **[方式三](#4-方式三手动-node-部署) · 手动 node 部署** | 已有进程管理（pm2/supervisor）/ 定制需求 | node 22+ + bun | ★★★ 完全自控 |

> 三种方式殊途同归，最终都是 `node apps/web/build/index.js` 起服务。**第一次部署建议选方式一**（5 分钟搞定，含 systemd 安全加固）。

---

## 1. 前置条件

| 组件 | 版本 | 方式一 | 方式二 | 方式三 | 说明 |
|---|---|---|---|---|---|
| systemd | 任意 | ✅ | — | — | 方式一必需 |
| Docker + Compose | 任意现代 | — | ✅ | — | 方式二必需 |
| Node.js | ≥ 22 | ✅ | — | ✅ | better-sqlite3 native addon 要 v22+ |
| Bun | ≥ 1.0 | ✅ | — | ✅ | 包管理 + 构建宿主 |
| rsync / curl / openssl | 任意 | ✅ | — | — | 方式一脚本用，通常预装 |
| SQLite | 由 better-sqlite3 内嵌 | — | — | — | 无需单独安装 |

**运行时分工（重要）**：`better-sqlite3` 是原生 addon，**bun 直接运行时加载失败**（仅 `bun + vite dev/build` 下可用）。因此测试用 vitest（node 下跑）、dev/build/install 用 bun、**生产用 `node apps/web/build/index.js`**。三种部署方式都已按此处理。

---

## 2. 方式一：systemd 一键安装（最简）

执行仓库内的 `scripts/install.sh`，一条命令完成：复制代码 → build → 生成密钥 → 写 systemd unit（含 17 项安全加固）→ 启动并验证健康。

### 2.1 装依赖（一次性）

```bash
# Ubuntu 22.04 / 24.04 / Debian 12
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs
curl -fsSL https://bun.sh/install | bash        # 装在 ~/.bun/bin
# 重新登录或 source ~/.bashrc 让 PATH 生效
```

### 2.2 跑安装脚本

```bash
git clone <repo> && cd remote-reader
sudo ./scripts/install.sh
```

脚本会显示参数 + 探测出的 BASE_URL，等你输 `y` 确认才动手。完成后打印访问 URL + 邀请码。

### 2.3 验证

```bash
sudo systemctl status remote-reader              # → active (running)
curl http://localhost:3000/api/health            # → {"ok":true}
```

浏览器打开 `http://<server-ip>:3000/register`，用脚本输出的 `INITIAL_INVITE_CODE` 注册首个 admin。

### 2.4 更多用法

参数化（端口 / 自定义路径 / 多实例）、预期输出、安全加固清单、升级、卸载、FAQ 等 → **见 [`scripts/README.md`](../scripts/README.md)**。

**一键卸载**：`sudo ./scripts/uninstall.sh`（默认保留数据；加 `--purge` 连数据一起删，删前二次确认。详见 [`scripts/README.md`](../scripts/README.md) 的「uninstall.sh」一节）。

**升级**：`sudo ./scripts/update.sh` 一键原地升级已部署实例（保留配置 + 数据，不重新生成 `SESSION_SECRET`，失败自动回滚。详见 [`scripts/README.md`](../scripts/README.md) 的「update.sh」一节）。

---

## 3. 方式二：Docker Compose（推荐生产）

镜像特性：多阶段构建、prod-only node_modules、**非 root 运行**（uid 1000）、HEALTHCHECK。

### 3.1 准备配置

```bash
git clone <repo> && cd remote-reader
cp .env.example .env            # 至少改这两项：
```

编辑 `.env`：

```bash
SESSION_SECRET=<32 字节以上长随机串>   # 生产必填，缺失 fail-fast
INITIAL_INVITE_CODE=<你的邀请码>       # 注册首个管理员所需
```

可选覆盖（`docker-compose.yml` 已设合理默认）：

```yaml
environment:
  - DATABASE_PATH=/app/data/app.db     # SQLite 路径
  - DATA_DIR=/app/data/documents        # 文档落盘根目录
  - BASE_URL=http://localhost:3000      # 生成分享链接的外链前缀（部署后改成你的域名）
```

### 3.2 启动

```bash
docker compose up -d --build
docker compose logs -f web    # 看到 "Listening on http://0.0.0.0:3000" 即就绪
```

访问 `http://localhost:3000`，应 302 跳转到 `/login`。

### 3.3 数据持久化

`docker-compose.yml` 把宿主机 `./data` 挂载到容器 `/app/data`。容器以 **node 用户（uid 1000）** 运行；`docker-entrypoint.sh` 会在启动时以 root `chown` 数据目录后通过 `runuser` 降权，因此宿主机 `./data` 无论初始属主是谁都能正常写入。`./data` 含数据库与文档，**绝不入库**（已 gitignore），按机密资料备份。

### 3.4 健康检查

镜像内置 `HEALTHCHECK`（命中 `/api/health`，30s 间隔）。`docker compose ps` 看到 `(healthy)` 即服务存活。

### 3.5 更新镜像

```bash
git pull
docker compose up -d --build    # 重建镜像并滚动重启
```

schema 变更时需额外跑 migration（见 §8.2）。

---

## 4. 方式三：手动 node 部署

适合不用 Docker、或想直接控制进程（pm2 / supervisor）的场景。如果用 systemd，直接选[方式一](#2-方式一systemd-一键安装最简)更省事。

### 4.1 构建

```bash
bun install
bun --filter remote-reader-web build       # 产物在 apps/web/build/
bun --filter remote-reader-web db:migrate  # 生成 data/app.db
```

### 4.2 启动（node）

```bash
SESSION_SECRET=<长随机串> \
INITIAL_INVITE_CODE=<邀请码> \
DATABASE_PATH=./data/app.db \
DATA_DIR=./data/documents \
BASE_URL=https://your-domain \
BODY_SIZE_LIMIT=8388608 \
PORT=3000 \
node apps/web/build/index.js
```

建议用 systemd / pm2 守护进程，前置 HTTPS 反向代理（见 §6）。

> ⚠️ 入口是 `apps/web/build/index.js`（启动 HTTP server），**不是** `build/handler.js`（仅导出 handler，不能独立运行）。
> ⚠️ **不要 `bun run` 启服务**——会触发 better-sqlite3 加载失败。

---

## 5. 注册首个管理员 & 生成 API token

### 5.1 注册首个管理员

启动后访问 `/register`，用 `INITIAL_INVITE_CODE` 注册——**第一个注册的用户自动成为 `admin`**。之后注册的用户为 `member`。`INITIAL_INVITE_CODE` 建议注册完首批用户后轮换。

### 5.2 生成 API token（给 Agent）

两种方式：

**UI**（推荐）：登录 → 设置 → API Token → 新建。明文 token **仅显示一次**，立即复制保存。

**脚本**：

```bash
# 仓库根目录跑（用 createRequire 定位依赖）
node scripts/seed-token.mjs <已注册用户的 email>
# → TOKEN=rr_...（明文只显示一次）

# 方式一装好的生产环境
sudo DATABASE_PATH=/var/lib/remote-reader/app.db \
    node /opt/remote-reader/scripts/seed-token.mjs admin@example.com
```

详见 [`scripts/README.md`](../scripts/README.md) 的「seed-token.mjs」一节。

> token 在数据库里只存 sha256 哈希，**明文丢失只能重新生成**。撤销：UI 一键，或手动改库。

---

## 6. 反向代理 + HTTPS

生产**必须 HTTPS**（session cookie 的 `secure` 标志依赖它）。前置 nginx / caddy。

**nginx 示例**：

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain;
    # ssl_certificate ...

    client_max_body_size 8m;     # 须 > MAX_UPLOAD_BYTES

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**caddy 示例**（自动 HTTPS）：

```
your-domain {
    reverse_proxy 127.0.0.1:3000
    request_body { max_size 8MB }
}
```

记得把 `/etc/remote-reader/env`（方式一）或 `.env`（方式二/三）里的 `BASE_URL` 改成 `https://your-domain` 后重启服务。

---

## 7. MCP 桥配置（Agent 上传）

桥无原生依赖，`bun apps/mcp-bridge/src/index.ts` 直跑。两种配置（env 优先于文件）：

**方式一：环境变量**（推荐）

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

配置缺失（既无 env 又无文件）桥启动即退（exit 1）并打印指引。配置好后 Agent 调 `upload_document({ name, content, path? })`，拿到查看链接。

> 调试：`npx @modelcontextprotocol/inspector bun apps/mcp-bridge/src/index.ts`，或 `bun apps/mcp-bridge/scripts/smoke-client.ts <url> <token>`（需 Web 应用在跑）。

---

## 8. 数据备份与升级

### 8.1 备份

数据位置取决于部署方式：

| 部署方式 | 数据目录 |
|---|---|
| 方式一（systemd） | `/var/lib/remote-reader/` |
| 方式二（Docker） | 宿主机 `./data/`（挂载到容器 `/app/data`） |
| 方式三（手动） | `./data/`（或自定义） |

无论哪种，备份策略相同（含 SQLite + 文档原文）：

```bash
# 方式一：先停服或热备
sudo systemctl stop remote-reader
sudo tar czf backup-$(date +%F).tar.gz /var/lib/remote-reader/
sudo systemctl start remote-reader

# 或只备份数据库（运行时也可，SQLite 一致性快照）
sudo sqlite3 /var/lib/remote-reader/app.db ".backup /var/lib/remote-reader/backup-$(date +%F).db"
```

### 8.2 升级 / 迁移

**schema 变更**后重新生成并执行 migration：

```bash
bun --filter remote-reader-web db:generate   # 生成新 migration SQL
bun --filter remote-reader-web db:migrate    # 应用（生产在停服/维护窗口执行）
```

**代码升级**按部署方式不同：

| 部署方式 | 升级步骤 |
|---|---|
| 方式一（systemd） | `sudo ./scripts/update.sh` 一键原地升级（保留配置 + 数据，失败自动回滚）。详见 [`scripts/README.md`](../scripts/README.md) 的「update.sh」一节 |
| 方式二（Docker） | `git pull && docker compose up -d --build`（migration 在镜像构建期已执行） |
| 方式三（手动） | `git pull && bun install && bun --filter remote-reader-web build` 后重启进程 |

> ⚠️ 升级前务必备份 `/var/lib/remote-reader/`（或对应数据目录）+ `/etc/remote-reader/env`（含 `SESSION_SECRET`，丢失会让所有已签发 session 失效）。

---

## 9. 配置参考（环境变量）

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
| `SESSION_MAX_AGE` | `2592000`（30 天，秒） | session 有效期 |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | adapter-node 监听 |
| `NODE_ENV` | — | 设 `production` 启用安全 cookie + 强制 SESSION_SECRET |

> 数值型变量用 `envInt` 严格解析：非正整数会在模块加载时抛错（fail-closed），不静默退化。

---

## 10. 故障排查

### 通用

| 现象 | 排查 |
|---|---|
| 生产启动报 `SESSION_SECRET must be set in production` | 设置 `SESSION_SECRET`（长随机串） |
| 生产启动报 `Invalid BODY_SIZE_LIMIT` | 改成字节数（如 `8388608`），不带单位 |
| `better-sqlite3 ... not supported` / `ERR_DLOPEN_FAILED` | 你在用 `bun run` 启服务——改用 `node apps/web/build/index.js` |
| 上传 >512K 返回 413 但你确定 < `MAX_UPLOAD_BYTES` | `BODY_SIZE_LIMIT` < 内容大小（adapter-node 默认仅 512K） |
| 注册时邀请码无效 | 核对 `INITIAL_INVITE_CODE` 与启动时一致 |
| seed-token 报 `Cannot find package 'better-sqlite3'` | 在**仓库根目录**执行（非 apps/web） |
| 链接打不开 / 404 | share token 失效或文档被删；让 Agent 重新上传 |
| 端口 5173 被占 | dev 自动切 5174；或改 `--port` |

### 方式一（systemd）专属

| 现象 | 排查 |
|---|---|
| `sudo ./install.sh` 报 `未找到 bun` | 确认用 `sudo` 跑（脚本会自动找 SUDO_USER 的 `~/.bun/bin`）；或临时 `sudo -E ./install.sh` |
| 服务起来但 `/api/health` 一直没过 | `sudo journalctl -u remote-reader -n 100`；最常见是端口冲突 / 数据目录权限错（应是 `remote-reader:remote-reader`） |
| 改了端口后访问不到 | 改完 `/etc/remote-reader/env` 后 `sudo systemctl restart remote-reader`；防火墙 `sudo ufw allow <port>` |
| 想看实时日志 | `sudo journalctl -u remote-reader -f` |
| `systemd-analyze security` 评分不理想 | 评分约 4.0–4.5 属正常（已经 17 项加固）；评分到 10.0 才需要警惕 |

### 方式二（Docker）专属

| 现象 | 排查 |
|---|---|
| Docker 容器 `unhealthy` | `docker compose logs web`；常见是端口/配置/env 缺失 |
| `./data` 目录权限错（root 属主写入失败） | `docker-entrypoint.sh` 会自动 chown；如仍失败，手动 `sudo chown -R 1000:1000 ./data` |
