# scripts/ · 自动化脚本

五个脚本，对应五类任务：

| 脚本 | 用途 | 何时用 | 调用方 |
|---|---|---|---|
| [`install.sh`](./install.sh) | 一键注册为 systemd 服务 | 全新部署 Ubuntu/Debian 服务器 | 部署者（root） |
| [`uninstall.sh`](./uninstall.sh) | 一键卸载 systemd 服务（install 逆操作） | 停服 / 清代码 / 可选删数据 | 部署者（root） |
| [`update.sh`](./update.sh) | 一键原地升级已部署服务（保留配置 + 数据） | 升级已部署的 systemd 实例 | 部署者（root） |
| [`seed-token.mjs`](./seed-token.mjs) | 免 UI 为已存在用户生成 API token | 自动化初始化 / UI 不可用时 | 部署者 / 运维 |
| [`e2e-check.sh`](./e2e-check.sh) | 端到端冒烟测试 | 升级后回归 / 验证部署是否正常 | 开发者 / CI |

---

## install.sh · systemd 一键安装

### 适用场景

把 Remote Reader 部署为一台 Linux 服务器上的 systemd 服务。适合**裸金属 / VPS / 单机**场景：不依赖 Docker，由 systemd 直接管进程（重启/查日志/资源限制都走系统标准工具）。

**做了什么**（每步有日志输出）：

1. 前置检查（root、OS、node ≥ 22、bun、rsync、systemd）
2. 自动探测 BASE_URL（首个非 loopback IPv4）
3. 创建系统用户 `remote-reader`（nologin shell）
4. rsync 代码到 `/opt/remote-reader`（排除 data / node_modules / build / .git）
5. `bun install` + `bun --filter remote-reader-web build` + 二次 `install --production` 剥离 devDeps
6. `openssl rand` 生成 `SESSION_SECRET`（base64 48）与 `INITIAL_INVITE_CODE`（hex 6）
7. 写 `/etc/remote-reader/env`（权限 640 root:remote-reader）
8. 写 `/etc/systemd/system/remote-reader.service`（含 17 项安全加固）
9. `systemctl daemon-reload && systemctl enable --now`
10. 等待 `/api/health` 通过（最多 15s），打印访问 URL + 邀请码

### 前置要求

| 组件 | 版本 | 安装命令（Ubuntu/Debian） |
|---|---|---|
| systemd | 任何现代 Ubuntu/Debian 自带 | — |
| node | ≥ 22 | `curl -fsSL https://deb.nodesource.com/setup_22.x \| sudo -E bash - && sudo apt install -y nodejs` |
| bun | ≥ 1.0 | `curl -fsSL https://bun.sh/install \| bash`（装在 `~/.bun/bin`，脚本会自动找） |
| rsync / curl / openssl | 任意 | 通常预装；缺则 `sudo apt install -y rsync curl openssl` |
| sudo / root | — | 整个脚本必须 `sudo` 跑 |

### 基本用法

```bash
# 在项目根目录
sudo ./scripts/install.sh
```

执行前会打印所有参数 + BASE_URL，等用户输 `y` 确认才动手。

### 可调参数（环境变量覆盖）

| 变量 | 默认 | 说明 |
|---|---|---|
| `INSTALL_DIR` | `/opt/remote-reader` | 代码安装路径（运行后只读） |
| `DATA_DIR` | `/var/lib/remote-reader` | DB + 文档数据目录（可写） |
| `PORT` | `3000` | 监听端口 |
| `SERVICE_USER` | `remote-reader` | 运行专用系统用户名 |
| `SERVICE_NAME` | `remote-reader` | systemd unit 名 |
| `BASE_URL` | 自动探测 `http://<内网IP>:<PORT>` | 上传返回链接里的外链前缀。**外网部署必改**为你的域名 |

示例：

```bash
# 改端口 + 设外网域名
sudo PORT=8443 BASE_URL=https://docs.example.com ./scripts/install.sh

# 装到自定义位置（比如要装多实例）
sudo INSTALL_DIR=/opt/rr-prod DATA_DIR=/var/lib/rr-prod SERVICE_NAME=rr-prod ./scripts/install.sh
```

### 预期输出（成功）

```
[install] 安装参数：
  源代码目录      /path/to/remote-reader
  安装目录        /opt/remote-reader
  数据目录        /var/lib/remote-reader
  监听端口        3000
  运行用户        remote-reader
  服务名          remote-reader
  BASE_URL        http://192.168.1.10:3000

[install] 确认开始安装？[y/N] y
✓ 用户已创建
✓ 代码已复制
✓ 依赖已安装
✓ 构建完成
✓ 生产依赖就绪
✓ env 已写入
✓ unit 已写入
✓ 服务健康（2s）

═══════ Remote Reader 已安装并启动 ═══════
  首页/登录           http://192.168.1.10:3000/login
  健康检查            http://192.168.1.10:3000/api/health

  注册首个管理员所需邀请码（仅显示一次）：
      0caa11bec3be
```

### 安装后验证

```bash
# 1. 服务状态
sudo systemctl status remote-reader
# → active (running)，最近日志 "Listening on http://0.0.0.0:3000"

# 2. health 检查
curl http://localhost:3000/api/health
# → {"ok":true}

# 3. 进程身份（确认非 root）
ps -o user= -p $(systemctl show -p MainPID --value remote-reader)
# → remote-reader

# 4. 安全加固评分（满分 0.0，越低越严，本项目约 4.0–4.5）
sudo systemd-analyze security remote-reader

# 5. 配置文件权限
ls -l /etc/remote-reader/env
# → -rw-r----- 1 root remote-reader ...
```

### 关键路径

| 路径 | 用途 | 备份？ |
|---|---|---|
| `/opt/remote-reader/` | 代码（只读） | ❌ 可重装 |
| `/var/lib/remote-reader/` | DB + 文档 | ✅ **必须备份** |
| `/etc/remote-reader/env` | 配置（含 SESSION_SECRET / INVITE_CODE） | ✅ 备份（注意密钥） |
| `/etc/systemd/system/remote-reader.service` | systemd unit | ❌ 可重生成 |

### 日志

```bash
sudo journalctl -u remote-reader -f              # 实时跟踪
sudo journalctl -u remote-reader -n 200          # 最近 200 行
sudo journalctl -u remote-reader --since "1h ago"
```

### 常用运维命令

```bash
sudo systemctl restart remote-reader             # 重启（改完 env 后）
sudo systemctl reload  remote-reader             # （暂不支持 hot reload，用 restart）
sudo systemctl stop    remote-reader
sudo systemctl disable remote-reader             # 取消开机自启
```

### 修改配置后生效

```bash
sudo vim /etc/remote-reader/env                  # 改 PORT / BASE_URL 等
sudo systemctl restart remote-reader
```

### 升级

**推荐：一键原地升级**（保留配置 + 数据，不重新生成 `SESSION_SECRET`，已登录 session 不失效）：

```bash
# 在项目源码克隆根目录
sudo ./scripts/update.sh
```

`update.sh` 从现有部署读参数（PORT/BASE_URL 等）→ 备份 → rsync 当前工作区代码 → rebuild → 重启 → health 校验，失败自动回滚（默认不 git pull，加 `--git` 才先拉取）。详见「[update.sh](#updatesh--一键原地升级)」一节。

> `install.sh` 检测到同名 service 会中止（防覆盖），所以**不要直接重跑 install.sh 升级**。下面两种手动方式是 `update.sh` 不可用时的后备：

**A. 原地重建**（数据不丢）：

```bash
sudo systemctl stop remote-reader
sudo rsync -a --delete \
    --exclude '/data' --exclude '/node_modules' --exclude '/apps/web/build' --exclude '/.git' \
    ./ /opt/remote-reader/
cd /opt/remote-reader && sudo bun install && sudo bun --filter remote-reader-web build
sudo systemctl start remote-reader
```

**B. 先卸载再装**（数据保留在 `/var/lib/remote-reader/`，env 保留在 `/etc/remote-reader/`）：

```bash
sudo systemctl disable --now remote-reader
sudo rm /etc/systemd/system/remote-reader.service
sudo systemctl daemon-reload
# 数据/配置不动；只删代码
sudo rm -rf /opt/remote-reader
# 把新代码放到当前目录后重跑 install.sh，但要把生成的 env 里的 SESSION_SECRET 换回原值
# 否则已签发的 session 全部失效
sudo ./scripts/install.sh
```

### 卸载

```bash
sudo systemctl disable --now remote-reader
sudo rm /etc/systemd/system/remote-reader.service
sudo systemctl daemon-reload
sudo userdel remote-reader                                       # 删用户（home 在 /var/lib，要加 -r 一起删数据）
sudo rm -rf /opt/remote-reader /var/lib/remote-reader /etc/remote-reader
```

> ⚠️ `userdel -r` 会删 `/var/lib/remote-reader`（数据目录）。如要保留数据，先备份再 `userdel`（不加 `-r`），手动 `rm -rf` 之外的其他路径。

### 安全加固清单

systemd unit 启用的 17 项 hardening：

| 加固项 | 作用 |
|---|---|
| `NoNewPrivileges=yes` | 禁止提权（setuid 等） |
| `ProtectSystem=strict` | 整个文件系统只读（除了 `ReadWritePaths`） |
| `ProtectHome=yes` | 隔离 `/home` / `/root` / `/run/user` |
| `PrivateTmp=yes` | 私有 `/tmp`，看不见其他进程的临时文件 |
| `PrivateDevices=yes` | 看不到 `/dev` 里的物理设备 |
| `ProtectKernelTunables/Modules/Logs=yes` | 阻断内核调优接口 |
| `ProtectControlGroups=yes` | 阻断 cgroup 写入 |
| `ProtectClock/Hostname=yes` | 阻断系统时钟 / 主机名修改 |
| `ProtectProc=invisible` | 看不到其他用户的进程 |
| `RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX` | 仅允许网络/Unix socket |
| `RestrictNamespaces=yes` | 禁止创建 namespace |
| `RestrictRealtime/SUIDSGID=yes` | 禁实时调度 / setuid-setgid |
| `LockPersonality=yes` | 锁定执行域（防 personality 切换） |
| `RemoveIPC=yes` | 停止后清理 IPC |
| `CapabilityBoundingSet=` + `AmbientCapabilities=` | 清空所有 Linux capabilities |
| `ReadWritePaths=${DATA_DIR}` | 仅数据目录可写 |
| `BindReadOnlyPaths=${INSTALL_DIR}` | 代码目录强只读 |
| `MemoryMax=512M` / `TasksMax=256` / `LimitNOFILE=65536` | 资源上限 |

### FAQ

**Q: 跑完报 `未找到 bun`，但我已经装了？**
A: 你用的是 `sudo ./install.sh` 还是 `./install.sh`？必须 `sudo`。脚本会从 `SUDO_USER` 找到原用户的 `~/.bun/bin` 并加进 PATH。如果还报错，临时 `sudo -E ./install.sh`。

**Q: 服务起来了但 `/api/health` 一直没过？**
A: `sudo journalctl -u remote-reader -n 100`。最常见原因：
- 端口已被占（改 `PORT` 后 restart）
- `/var/lib/remote-reader` 权限错（应该是 `remote-reader:remote-reader`）
- better-sqlite3 加载失败（node 版本太低，需要 ≥ 22）

**Q: 已经装过一次，再跑就中止？**
A: 设计如此（防覆盖）。先按「卸载」清干净再装，或按「升级 - B」走保留数据流程。

**Q: 改了端口后访问不到？**
A: 改完 `/etc/remote-reader/env` 里的 `PORT` 后 `sudo systemctl restart remote-reader`。如果防火墙开着还要 `sudo ufw allow <new-port>`。

**Q: BASE_URL 自动探测的 IP 不对？**
A: 多网卡机器 `hostname -I` 返回多个 IP，脚本取第一个。如果不对，显式 `sudo BASE_URL=https://your-domain ./scripts/install.sh`。

**Q: 想看脚本会做什么但不真跑？**
A: 当前没有 dry-run 模式。可以先 `bash -n scripts/install.sh` 看语法，再 `less scripts/install.sh` 通读。所有写操作都在前面有 log 输出，跑到 `y/N` 确认时按 `N` 中止即可。

---

## uninstall.sh · 一键卸载（install.sh 的逆操作）

**用途**：把 `install.sh` 装上的 systemd 服务、代码、配置清除干净；**数据默认保留**，可选用 `--purge` 连数据一起删。

**做了什么**（每步 `[uninstall]` 日志，失败不静默）：

1. 前置检查（root、systemd、拒绝 `DATA_DIR`/`INSTALL_DIR` 为空或 `/`）
2. 存在性检测：unit / 代码 / 数据 **全无残留 → 友好退出**（幂等，不报错）
3. 读旧 `PORT`（若 env 还在）→ 结尾精确提示 ufw
4. 打印操作清单 + 主确认（`-y` 跳过）；`--purge` 模式删数据前**二次确认**
5. 执行清理（每步容错，半残状态也能清干净）：
   - `systemctl stop` + `disable`
   - 删 unit → `daemon-reload` + `reset-failed`
   - `rm -rf` 代码目录 + 配置目录
   - **仅 `--purge`**：`rm -rf` 数据目录
   - `userdel`（**永不加 `-r`**，见下）
6. ufw 启用则提示（只读不删）

### 基本用法

```bash
sudo ./scripts/uninstall.sh                 # 停服 + 删代码/配置，保留数据
sudo ./scripts/uninstall.sh --purge         # 连数据一起删（删前二次确认）
sudo ./scripts/uninstall.sh --yes           # 跳过所有确认（自动化）
```

### 参数

| 参数 / 变量 | 默认 | 说明 |
|---|---|---|
| `--purge` | 关 | 连数据目录一起永久删除（删前单独确认） |
| `-y` / `--yes` | 关 | 跳过所有确认 |
| `-h` / `--help` | — | 显示帮助 |
| `SERVICE_NAME` | `remote-reader` | unit 名（多实例须与安装时一致） |
| `SERVICE_USER` | `remote-reader` | 运行用户 |
| `INSTALL_DIR` | `/opt/remote-reader` | 代码目录 |
| `DATA_DIR` | `/var/lib/remote-reader` | 数据目录（保留/删除目标） |

### 安全设计

- **默认保留数据**：破坏性操作不作为默认，需显式 `--purge`。
- **单一数据删除入口**：数据只在 `--purge` 分支删一处；`userdel` 永不加 `-r`（`install.sh` 把用户 home 指向 `DATA_DIR`，`-r` 会顺带删数据）。
- **双重确认**：`--purge` 删数据前再问一次；取消则降级为保留数据继续。
- **拒绝危险路径**：`DATA_DIR`/`INSTALL_DIR` 为空或 `/` 时中止，防 `rm -rf /` 类事故。
- **幂等**：未安装直接友好退出；半残状态（如服务在跑但 unit 已删）也能清干净。
- **不动 ufw**：防火墙规则只提示不自动删（`install.sh` 当初也没动）。

### 卸载后

- 默认保留 `/var/lib/remote-reader/`（DB + 文档），手动 `sudo rm -rf` 即可彻底清掉。
- `/etc/remote-reader/env` 含 `SESSION_SECRET`，卸载即删；重装会生成新密钥，**旧 session 全部失效**。要保 session，卸载前备份该值，重装后写回。

---

## update.sh · 一键原地升级（install.sh 的升级版）

**用途**：把已用 `install.sh` 部署的 systemd 实例**原地升级**到最新代码，**保留全部配置与数据**。比"卸载 + 重装"更省事：不重新生成 `SESSION_SECRET`（已登录 session 不失效）、不碰 `/var/lib`（DB / 文档 / API token / 分享链接全保留）、不要求重传 `PORT`/`BASE_URL`。

**做了什么**（每步 `[update]` 日志）：

1. 前置检查（root、systemd、service/代码/env 齐备、node ≥ 22、bun、rsync、curl；`--git` 模式额外要求源码是 git 仓库且工作区干净）
2. 从 `/etc/remote-reader/env` 读 `PORT`/`BASE_URL` 等（无需重传）
3. 打印读取到的参数 + 操作清单 + 升级前备份提示 → `y/N` 确认
4. `--git` 模式：`git pull --ff-only` 拉取最新代码（只动克隆，不碰 `INSTALL_DIR`）；默认模式：跳过，直接用当前工作区代码
5. **整目录备份** `/opt/remote-reader` → `/opt/remote-reader.bak`（含 build + node_modules，兜底 better-sqlite3 ABI 坑）
6. `rsync -a --delete` 新码到 `INSTALL_DIR`（排除 data / node_modules / build / .git / .env）
7. `chown root:root` + `bun install` + `bun --filter remote-reader-web build` + 剥离 devDeps（与 install.sh 同 build 链路）
8. `systemctl restart` → 轮询 `/api/health`（最多 30s）
9. **health 不过则自动回滚** `INSTALL_DIR` ← `.bak` + 重启 + 告警；通过则清理 `.bak` + 总结

### 基本用法

```bash
sudo ./scripts/update.sh              # 用当前工作区代码原地升级（默认不 git pull）
sudo ./scripts/update.sh --git        # 先 git pull 拉最新码再升级
sudo ./scripts/update.sh -y           # 跳过确认（自动化）
```

### 参数

| 参数 / 变量 | 默认 | 说明 |
|---|---|---|
| `--git` | 关 | 先 `git pull --ff-only` 拉最新码（默认跳过，用当前工作区代码升级） |
| `-y` / `--yes` | 关 | 跳过确认 |
| `-h` / `--help` | — | 显示帮助 |
| `INSTALL_DIR` | `/opt/remote-reader` | 代码目录（须与安装时一致） |
| `SERVICE_NAME` | `remote-reader` | unit 名（多实例须与安装时一致） |
| `SERVICE_USER` | `remote-reader` | 运行用户（仅展示，升级不改其归属） |

`PORT` / `BASE_URL` 等运行参数**从现有部署的 env 读取**，不接受命令行/环境变量覆盖（升级不应改配置）。

### 安全设计

- **配置与数据零改动**：不写 `env`、不碰 `/var/lib`、不重新生成 `SESSION_SECRET`（Web 不用重登）。
- **失败必回滚**：rebuild 前整目录备份；任何中途失败（build 报错等）或 health 不过，EXIT trap 自动 `mv` 还原 `INSTALL_DIR` 并重启，绝不让服务停在起不来的状态。
- **整目录备份**（而非只备份 `build/`）：better-sqlite3 的 `.node` 在 `node_modules` 里，bun 重编译可能产出与生产 node ABI 不匹配的二进制，只备份 `build` 不足以回滚。
- **health 校验**：生产跑 `node apps/web/build/index.js`，ABI 不匹配只在此时暴露；build 通过 ≠ 生产可跑。
- **拒绝危险路径**：`INSTALL_DIR` 为空或 `/` 时中止（回滚要 `rm -rf INSTALL_DIR`）。
- **`--git` 模式才要求 git 工作区干净**：默认模式用当前工作区代码 rsync、不 pull、不要求干净；`--git` 模式才检查工作区干净再 `git pull`（脏工作区会冲突）。
- **中断可识别**：上次升级中断留下的 `.bak` 会被检测到并拒绝盲跑，提示人工确认。
- **幂等**：成功后自动清理 `.bak`，重复跑不报错；`systemctl restart` 本身幂等（默认模式不 `git pull`；`--git` 模式的 `git pull` 幂等）。

### 已知坑（实测踩过，脚本已处理）

| 坑 | 对策 |
|---|---|
| `sudo` 找不到 bun（secure_path 不含 `~/.bun/bin`） | 从 `SUDO_USER` 取 home，加进 `PATH` |
| sudo 下 `~/.bun-install` 不可写 | `export BUN_INSTALL_CACHE_DIR=/tmp/.bun-cache` |
| bun 重编译 better-sqlite3 产出与 node 22（ABI 127）不匹配的 `.node` | 整目录备份 + health 校验 + 失败回滚 |

---

## seed-token.mjs · 免 UI 生成 API token

**用途**：跳过 Web UI，直接写 SQLite 为某已注册用户生成一个 API token。适合首次部署后用脚本快速拿到 token 配置 MCP 桥。

**用法**：

```bash
node scripts/seed-token.mjs <已注册用户的 email>
# → TOKEN=rr_xxxxxxxxxxxxxxxxxxxxxxxxx（明文仅显示一次）
```

**前置**：
- 在仓库根目录跑（用 `createRequire` 定位依赖）
- `DATABASE_PATH` 环境变量指向正确的 db（默认 `apps/web/data/app.db`）
- 用户必须已存在（先在 UI 用邀请码注册）

**生产环境配合 install.sh**：

```bash
# 装好后用脚本直接为已注册用户签 token（DB 在 /var/lib/remote-reader/app.db）
sudo DATABASE_PATH=/var/lib/remote-reader/app.db \
    node /opt/remote-reader/scripts/seed-token.mjs admin@example.com
```

> ⚠️ 此操作会以 root 读 db；脚本本身无副作用除了插入一行 token 记录。

---

## e2e-check.sh · 端到端冒烟测试

**用途**：在已起服务的环境（dev 或生产）跑一系列 curl，验证关键路径符合预期：上传、免登录查看、401/413/404、路径穿越防护。

**用法**：

```bash
# 假设 dev 服务在 5173，已有 API token
API_TOKEN=rr_xxx BASE_URL=http://localhost:5173 ./scripts/e2e-check.sh

# 或 install.sh 装好后测生产
API_TOKEN=rr_xxx BASE_URL=http://localhost:3000 ./scripts/e2e-check.sh
```

**检查项**（任一失败即 exit 1）：
- `POST /api/v1/documents` 上传 → 返回 `{id, url}`
- `GET /s/<token>` 免登录 → 200
- 上传无 token → 401
- 上传超大内容（6MB）→ 413
- 失效 share token → 404
- name 含 `../../../evil.md` → 400
- path 含 `../escape` → 400

成功输出：`✓ 子计划 1 端到端通过（上传→免登录查看→401/413/404/400 穿越防护）`。

---

## 开发提示

- 除 `seed-token.mjs` 需要 better-sqlite3 外，其余 bash 脚本都不依赖项目运行时，可以独立分发。
- install.sh 的逻辑都按"前可预测、后可追溯"设计：每步有 `[install]` log 前缀，失败不静默。
- 想加新脚本时保持同样风格：set -euo pipefail、颜色 log 函数、前置检查、可参数化。
