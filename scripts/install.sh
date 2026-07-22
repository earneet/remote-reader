#!/usr/bin/env bash
# Remote Reader 一键安装为 systemd 服务（Ubuntu/Debian，Node 直跑模式）
#
# 用法（在项目根目录）：
#   sudo ./scripts/install.sh
#
# 可用环境变量覆盖默认值：
#   INSTALL_DIR=/opt/remote-reader      代码安装路径
#   DATA_DIR=/var/lib/remote-reader     DB 与文档数据目录
#   PORT=3000                           监听端口
#   SERVICE_USER=remote-reader          运行专用系统用户
#   SERVICE_NAME=remote-reader          systemd unit 名
#   BASE_URL=http://<host>:<port>       上传返回链接里的外网可达 base
#                                       （留空则脚本尝试自动探测）
set -euo pipefail

# ---- 默认参数 ----
INSTALL_DIR="${INSTALL_DIR:-/opt/remote-reader}"
DATA_DIR="${DATA_DIR:-/var/lib/remote-reader}"
PORT="${PORT:-3000}"
SERVICE_USER="${SERVICE_USER:-remote-reader}"
SERVICE_NAME="${SERVICE_NAME:-remote-reader}"
CONFIG_DIR="/etc/${SERVICE_NAME}"
NODE_MIN_MAJOR=22

# ---- 颜色 ----
if [[ -t 1 ]]; then
    C_RESET=$'\e[0m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'
    C_RED=$'\e[31m'; C_BLUE=$'\e[34m'; C_BOLD=$'\e[1m'
else
    C_RESET=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""; C_BOLD=""
fi

log()  { printf '%s[%s]%s %s\n' "${C_BLUE}" "install" "${C_RESET}" "$*"; }
ok()   { printf '%s✓%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf '%s!%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "${C_RED}" "${C_RESET}" "$*" >&2; exit 1; }

# ---- 1. 前置检查 ----
[[ $EUID -eq 0 ]] || die "需要 root 权限，请用 sudo 运行：sudo $0"

# 找到项目根（脚本所在目录的上一级，含 package.json + apps/web）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
[[ -f "${SRC_DIR}/package.json" ]] || die "未在项目根找到 package.json：${SRC_DIR}"
[[ -d "${SRC_DIR}/apps/web" ]]     || die "未找到 apps/web 目录：${SRC_DIR}/apps/web"
[[ -d "${SRC_DIR}/apps/mcp-bridge" ]] || die "未找到 apps/mcp-bridge 目录"

# 检测 init 系统（支持 systemd 才有意义）
[[ -d /run/systemd/system ]] || die "未检测到 systemd，本脚本仅支持 systemd 发行版（Ubuntu 16.04+/Debian 8+）"

# sudo 会重置 PATH（secure_path），导致找不到用户级安装的 bun（通常在 ~/.bun/bin）。
# 如果是 sudo 跑的，主动把原用户的 bun 路径加进来。
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    SUDO_HOME="$(getent passwd "${SUDO_USER}" | cut -d: -f6)"
    [[ -d "${SUDO_HOME}/.bun/bin" ]] && export PATH="${SUDO_HOME}/.bun/bin:${PATH}"
fi

command -v node >/dev/null 2>&1 || die "未找到 node。Ubuntu 安装：curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt install -y nodejs"
command -v bun  >/dev/null 2>&1 || die "未找到 bun（构建用）。安装：curl -fsSL https://bun.sh/install | bash，然后重新登录或 source ~/.bashrc"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "${NODE_MAJOR}" -ge "${NODE_MIN_MAJOR}" ]] || die "node 版本过低（${NODE_MAJOR}.x），需要 ${NODE_MIN_MAJOR}+。建议 NodeSource 安装 node ${NODE_MIN_MAJOR} LTS"

# 检测是否有旧安装残留（不强制阻止，只提示）
if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}\.service"; then
    warn "检测到已存在 ${SERVICE_NAME}.service，本脚本不会自动覆盖。如需重装，请先执行："
    warn "  sudo systemctl disable --now ${SERVICE_NAME} && sudo rm /etc/systemd/system/${SERVICE_NAME}.service && sudo systemctl daemon-reload"
    die "已存在同名 service，中止。"
fi

# ---- 2. 自动探测 BASE_URL（如果用户没传）----
if [[ -z "${BASE_URL:-}" ]]; then
    # 取本机第一非 loopback IPv4
    LAN_IP="$(hostname -I 2>/dev/null | awk '{print $1}')"
    if [[ -n "${LAN_IP}" ]]; then
        BASE_URL="http://${LAN_IP}:${PORT}"
    else
        BASE_URL="http://localhost:${PORT}"
    fi
fi

log "安装参数："
printf '  源代码目录      %s\n' "${SRC_DIR}"
printf '  安装目录        %s\n' "${INSTALL_DIR}"
printf '  数据目录        %s\n' "${DATA_DIR}"
printf '  监听端口        %s\n' "${PORT}"
printf '  运行用户        %s\n' "${SERVICE_USER}"
printf '  服务名          %s\n' "${SERVICE_NAME}"
printf '  BASE_URL        %s\n' "${BASE_URL}"
echo

read -r -p "$(printf '%s确认开始安装？[y/N] %s' "${C_BOLD}" "${C_RESET}")" ans
[[ "${ans}" =~ ^[Yy]$ ]] || { log "已取消"; exit 0; }

# ---- 3. 创建系统用户 ----
if ! id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    log "创建系统用户 ${SERVICE_USER}"
    useradd --system \
        --home "${DATA_DIR}" \
        --shell /usr/sbin/nologin \
        --no-create-home \
        "${SERVICE_USER}"
    ok "用户已创建"
else
    warn "用户 ${SERVICE_USER} 已存在，跳过创建"
fi

# ---- 4. 创建目录 + 复制代码 ----
log "创建目录"
mkdir -p "${INSTALL_DIR}" "${DATA_DIR}" "${CONFIG_DIR}"

log "复制代码到 ${INSTALL_DIR}"
# 排除：开发产物、运行时数据、版本控制；保留 source maps 以便排错
rsync -a --delete \
    --exclude '/data' \
    --exclude '/node_modules' \
    --exclude '/apps/web/node_modules' \
    --exclude '/apps/web/build' \
    --exclude '/apps/web/.svelte-kit' \
    --exclude '/packages/shared/node_modules' \
    --exclude '/apps/mcp-bridge/node_modules' \
    --exclude '/.git' \
    --exclude '/.env' \
    --exclude '/.env.local' \
    "${SRC_DIR}/" "${INSTALL_DIR}/"
ok "代码已复制"

# ---- 5. 安装依赖 + 构建 ----
# service user 是 nologin，不应该跑 bun；所有构建都用当前 sudoer（root）
BUN_BIN="$(command -v bun)"
log "安装依赖（bun install）：${BUN_BIN}"
# 共享缓存目录避免 sudo 下找不到 ~/.bun-install
export BUN_INSTALL_CACHE_DIR=/tmp/.bun-cache
mkdir -p "${BUN_INSTALL_CACHE_DIR}"
(cd "${INSTALL_DIR}" && "${BUN_BIN}" install)
ok "依赖已安装"

log "构建 web 应用（adapter-node 产物）"
(cd "${INSTALL_DIR}" && "${BUN_BIN}" --filter remote-reader-web build)
ok "构建完成"

# 剥离 devDependencies（vite build 已把 workspace 依赖内联到 build/server）
log "整理生产 node_modules"
(cd "${INSTALL_DIR}" && rm -rf node_modules apps/web/node_modules packages/shared/node_modules apps/mcp-bridge/node_modules bun.lock)
(cd "${INSTALL_DIR}" && "${BUN_BIN}" install --production)
ok "生产依赖就绪"

# 代码目录归 root，防止 service user 改动
chown -R root:root "${INSTALL_DIR}"

# 数据目录归 service user
chown -R "${SERVICE_USER}:${SERVICE_USER}" "${DATA_DIR}"
chmod 750 "${DATA_DIR}"

# ---- 6. 生成密钥 + 写 env ----
log "生成 SESSION_SECRET 与 INITIAL_INVITE_CODE"
SESSION_SECRET="$(openssl rand -base64 48 | tr -d '\n')"
INITIAL_INVITE_CODE="$(openssl rand -hex 6)"

ENV_FILE="${CONFIG_DIR}/env"
log "写入 ${ENV_FILE}"
cat > "${ENV_FILE}" <<EOF
# 由 install.sh 生成 $(date -Iseconds)
# 完整变量说明见源码 .env.example
NODE_ENV=production
PORT=${PORT}
BASE_URL=${BASE_URL}
DATABASE_PATH=${DATA_DIR}/app.db
DATA_DIR=${DATA_DIR}/documents
SESSION_SECRET=${SESSION_SECRET}
INITIAL_INVITE_CODE=${INITIAL_INVITE_CODE}
MAX_UPLOAD_BYTES=5242880
BODY_SIZE_LIMIT=8388608
RATE_LIMIT_MAX=60
RATE_LIMIT_WINDOW_MS=60000
LOGIN_RATE_LIMIT_MAX=10
SESSION_MAX_AGE=2592000
EOF
chmod 640 "${ENV_FILE}"
chown root:"${SERVICE_USER}" "${ENV_FILE}"
ok "env 已写入（含密钥，权限 640 root:${SERVICE_USER}）"

# ---- 7. 写 systemd unit ----
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
log "写入 ${UNIT_FILE}"

cat > "${UNIT_FILE}" <<EOF
[Unit]
Description=Remote Reader (Markdown delivery for AI agents)
Documentation=https://github.com/remote-reader/remote-reader
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=$(command -v node) apps/web/build/index.js
Restart=on-failure
RestartSec=5
TimeoutStopSec=10
KillSignal=SIGINT

# --- Hardening ---
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=yes
PrivateTmp=yes
PrivateDevices=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
ProtectClock=yes
ProtectHostname=yes
ProtectKernelLogs=yes
ProtectProc=invisible
RestrictAddressFamilies=AF_INET AF_INET6 AF_UNIX
RestrictNamespaces=yes
RestrictRealtime=yes
RestrictSUIDSGID=yes
LockPersonality=yes
MemoryDenyWriteExecute=no
RemoveIPC=yes
CapabilityBoundingSet=
AmbientCapabilities=
# 仅允许写数据目录；代码/配置只读
ReadWritePaths=${DATA_DIR}
BindReadOnlyPaths=${INSTALL_DIR}

# 资源限制
LimitNOFILE=65536
MemoryMax=512M
TasksMax=256

[Install]
WantedBy=multi-user.target
EOF
chmod 644 "${UNIT_FILE}"
ok "unit 已写入"

# ---- 8. 启动 ----
log "systemctl daemon-reload + enable + start"
systemctl daemon-reload
systemctl enable --now "${SERVICE_NAME}.service"

# ---- 9. 等待健康 ----
log "等待服务就绪（最多 15s）"
HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
for i in $(seq 1 15); do
    if curl -sf "${HEALTH_URL}" >/dev/null 2>&1; then
        ok "服务健康（${i}s）"
        break
    fi
    sleep 1
    if [[ $i -eq 15 ]]; then
        warn "服务未在 15s 内通过 health 检查，查看日志：journalctl -u ${SERVICE_NAME} -n 50"
    fi
done

# ---- 10. 总结 ----
echo
printf '%s═══════════════════════════════════════════════════════════════%s\n' "${C_GREEN}" "${C_RESET}"
printf '%s Remote Reader 已安装并启动%s\n' "${C_BOLD}${C_GREEN}" "${C_RESET}"
printf '%s═══════════════════════════════════════════════════════════════%s\n' "${C_GREEN}" "${C_RESET}"
echo
printf '  首页/登录           %s/login\n' "${BASE_URL}"
printf '  健康检查            %s/api/health\n' "${BASE_URL}"
echo
printf '  %s注册首个管理员所需邀请码%s（仅显示一次，妥善保存）：\n' "${C_YELLOW}" "${C_RESET}"
printf '      %s%s%s\n' "${C_BOLD}" "${INITIAL_INVITE_CODE}" "${C_RESET}"
echo
printf '  %s关键路径%s\n' "${C_BOLD}" "${C_RESET}"
printf '      代码              %s\n' "${INSTALL_DIR}"
printf '      数据              %s\n' "${DATA_DIR}"
printf '      配置（含密钥）    %s\n' "${ENV_FILE}"
printf '      systemd unit      %s\n' "${UNIT_FILE}"
echo
printf '  %s常用命令%s\n' "${C_BOLD}" "${C_RESET}"
printf '      看状态            systemctl status %s\n' "${SERVICE_NAME}"
printf '      跟踪日志          journalctl -u %s -f\n' "${SERVICE_NAME}"
printf '      重启              sudo systemctl restart %s\n' "${SERVICE_NAME}"
printf '      停止              sudo systemctl stop %s\n' "${SERVICE_NAME}"
echo
printf '  %s下一步%s\n' "${C_BOLD}" "${C_RESET}"
printf '    1) 浏览器打开上面的 /login，点注册，粘贴邀请码\n'
printf '    2) 登录后在 /settings/tokens 生成 API token\n'
printf '    3) 配置本地 MCP 桥（apps/mcp-bridge）：\n'
printf '       把 %s 里的 BASE_URL 和新 token 填到\n' "${ENV_FILE}"
printf '       ~/.config/remote-reader/config.json 即可\n'
echo
printf '%s⚠️  如果 health 未通过或注册失败：%s\n' "${C_YELLOW}" "${C_RESET}"
printf '    journalctl -u %s -n 100 --no-pager\n' "${SERVICE_NAME}"
printf '    最常见原因：端口 %s 被占用（改 PORT 后重启）、BASE_URL 不可达\n' "${PORT}"
echo
