#!/usr/bin/env bash
# Remote Reader 一键原地升级已部署的 systemd 服务（install.sh 的升级版，Ubuntu/Debian）
#
# 相比"卸载 + 重装"的优势：
#   - 不重新生成 SESSION_SECRET（已登录 session 不失效，Web 不用重登）
#   - 不碰 /var/lib（DB / 文档 / API token / 分享链接全保留）
#   - 不要求重传 PORT / BASE_URL（从现有部署读取）
#
# 用法（在项目源码克隆根目录）：
#   sudo ./scripts/update.sh               # 用当前工作区代码升级（默认不 git pull）
#   sudo ./scripts/update.sh --git         # 先 git pull 拉最新码再升级
#   sudo ./scripts/update.sh -y            # 跳过确认（自动化）
#
# 运行参数全部从现有部署读取（/etc/remote-reader/env + systemd），无需重传；
# 仅 INSTALL_DIR / SERVICE_NAME / SERVICE_USER 支持环境变量覆盖（与 install.sh 一致）：
#   INSTALL_DIR=/opt/remote-reader          代码安装路径
#   SERVICE_NAME=remote-reader              systemd unit 名
#   SERVICE_USER=remote-reader              运行专用系统用户（仅用于展示，升级不改其归属）
set -euo pipefail

# ---- 默认参数（与 install.sh 一致，保证能精准定位同一实例）----
INSTALL_DIR="${INSTALL_DIR:-/opt/remote-reader}"
SERVICE_NAME="${SERVICE_NAME:-remote-reader}"
SERVICE_USER="${SERVICE_USER:-remote-reader}"
CONFIG_DIR="/etc/${SERVICE_NAME}"
ENV_FILE="${CONFIG_DIR}/env"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
LOG_DIR="${LOG_DIR:-/var/log/remote-reader}"
LOGROTATE_FILE="/etc/logrotate.d/${SERVICE_NAME}"
NODE_MIN_MAJOR=22
BACKUP_DIR="${INSTALL_DIR}.bak"
BACKUP_TMP="${INSTALL_DIR}.bak.tmp"
HEALTH_WAIT=30
# unit/env 的升级期备份（回滚恢复用；成功后删除，残留检测在开头兜底）。
# 放 CONFIG_DIR 而非 /etc/systemd/system——后者里的杂后缀文件可能触发 systemd 扫描告警
UNIT_BAK="${CONFIG_DIR}/unit.update-bak"
ENV_BAK="${CONFIG_DIR}/env.update-bak"

# ---- 解析命令行参数 ----
ASSUME_YES=0
GIT_PULL=0
usage() {
    cat <<EOF
用法: sudo ./scripts/update.sh [--git] [-y|--yes] [-h|--help]
  --git        先 git pull 拉最新码（默认跳过，用当前工作区代码升级）
  -y, --yes    跳过确认（自动化场景）
  -h, --help   显示本帮助
从现有部署读取参数（${ENV_FILE} + systemd），原地升级代码并 rebuild，
保留全部配置与数据（不重新生成 SESSION_SECRET，不动 /var/lib）。
默认用当前工作区代码（SRC_DIR）rsync 到部署目录，不 git pull；加 --git 才先拉取。
环境变量覆盖: INSTALL_DIR / SERVICE_NAME / SERVICE_USER
EOF
}
while [[ $# -gt 0 ]]; do
    case "$1" in
        --git) GIT_PULL=1; shift ;;
        -y|--yes) ASSUME_YES=1; shift ;;
        -h|--help) usage; exit 0 ;;
        *) printf '未知参数: %s\n' "$1" >&2; usage >&2; exit 1 ;;
    esac
done

# ---- 颜色 ----
if [[ -t 1 ]]; then
    C_RESET=$'\e[0m'; C_GREEN=$'\e[32m'; C_YELLOW=$'\e[33m'
    C_RED=$'\e[31m'; C_BLUE=$'\e[34m'; C_BOLD=$'\e[1m'
else
    C_RESET=""; C_GREEN=""; C_YELLOW=""; C_RED=""; C_BLUE=""; C_BOLD=""
fi

log()  { printf '%s[%s]%s %s\n' "${C_BLUE}" "update" "${C_RESET}" "$*"; }
ok()   { printf '%s✓%s %s\n' "${C_GREEN}" "${C_RESET}" "$*"; }
warn() { printf '%s!%s %s\n' "${C_YELLOW}" "${C_RESET}" "$*" >&2; }
die()  { printf '%s✗%s %s\n' "${C_RED}" "${C_RESET}" "$*" >&2; exit 1; }

confirm() {
    # $1 = 提示语;返回 0=确认, 1=取消
    if [[ "${ASSUME_YES}" -eq 1 ]]; then return 0; fi
    local ans=""
    read -r -p "$(printf '%s%s%s [y/N] ' "${C_BOLD}" "$1" "${C_RESET}")" ans || true
    [[ "${ans}" =~ ^[Yy]$ ]]
}

# 从 env 文件取某 KEY 的值（KEY=value 行，去掉首尾空白）
env_val() { awk -F= -v k="$1" '$1==k{sub(/^[^=]*=/,""); print; exit}' "${ENV_FILE}" 2>/dev/null | tr -d '\r\n[:space:]'; }

# ---- 回滚机制（rebuild 前整目录备份；任何中途失败或 health 不过都还原）----
# 本脚本对生产做原地 rebuild，最大风险是把能跑的服务搞成起不来。better-sqlite3 的
# .node 在 node_modules 里（不在 build/），bun 重编译可能产出与生产 node ABI 不匹配
# 的二进制；故必须整目录备份，回滚才完整。do_rollback 自身命令都容错，避免在 trap 里二次失败。
# 升级期还可能改了 unit（模板刷新）与 env（ORIGIN 迁移）——一并备份恢复。
ROLLED_BACK=0
do_rollback() {
    [[ -d "${BACKUP_DIR}" ]] || return 0
    warn "升级未通过，自动回滚 ${INSTALL_DIR} ← ${BACKUP_DIR}"
    rm -rf "${INSTALL_DIR}"
    mv "${BACKUP_DIR}" "${INSTALL_DIR}"
    chown -R root:root "${INSTALL_DIR}" 2>/dev/null || true
    if [[ -f "${UNIT_BAK}" ]]; then
        mv -f "${UNIT_BAK}" "${UNIT_FILE}" 2>/dev/null || true
        systemctl daemon-reload 2>/dev/null || true
        warn "已恢复升级前 unit"
    fi
    if [[ -f "${ENV_BAK}" ]]; then
        mv -f "${ENV_BAK}" "${ENV_FILE}" 2>/dev/null || true
        warn "已恢复升级前 env"
    fi
    log "重启服务以应用回滚后的代码"
    systemctl restart "${SERVICE_NAME}.service" 2>/dev/null || true
    # 回滚后同样轮询：旧代码冷启动也要数秒，单次 curl 会把"还在启动"误报成"回滚失败"
    local i
    for i in $(seq 1 "${HEALTH_WAIT}"); do
        if curl -sf "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
            ok "已回滚，服务恢复到升级前版本（${i}s）"
            ROLLED_BACK=1
            return 0
        fi
        sleep 1
    done
    warn "已回滚但 ${HEALTH_WAIT}s 内 health 仍未通过——服务可能本就异常，请排查：journalctl -u ${SERVICE_NAME} -n 100"
    ROLLED_BACK=1
}
cleanup() {
    local code=$?
    if [[ ${code} -ne 0 && ${ROLLED_BACK} -eq 0 ]]; then
        do_rollback
    fi
    exit "${code}"
}

# ---- 1. 前置检查 ----
[[ $EUID -eq 0 ]] || die "需要 root 权限，请用 sudo 运行：sudo $0"
[[ -d /run/systemd/system ]] || die "未检测到 systemd，本脚本仅支持 systemd 发行版"

# 拒绝危险路径：回滚时会 rm -rf INSTALL_DIR，空或根目录会酿成灾难
[[ -n "${INSTALL_DIR}" && "${INSTALL_DIR}" != "/" ]] || die "INSTALL_DIR 非法（${INSTALL_DIR:-空}），拒绝执行"
[[ -n "${SERVICE_NAME}" ]] || die "SERVICE_NAME 不能为空"

# 定位源码根（脚本上一级，含 package.json + apps/web）
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="$(cd "${SCRIPT_DIR}/.." && pwd)"
[[ -f "${SRC_DIR}/package.json" ]] || die "未在源码根找到 package.json：${SRC_DIR}"
[[ -d "${SRC_DIR}/apps/web" ]]     || die "未找到 apps/web 目录：${SRC_DIR}/apps/web"

# 部署辅助函数（BODY_SIZE_LIMIT 计算 / better-sqlite3 ABI 自修），与 install.sh 共用单源
# shellcheck source=lib-deploy.sh
source "${SCRIPT_DIR}/lib-deploy.sh"
die_if_src_is_install_dir "${SRC_DIR}" "${INSTALL_DIR}"

# 解析原属主（脚本经 sudo 跑时，源码克隆通常属 SUDO_USER）；git 操作需以其身份执行
SUDO_HOME=""
if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
    SUDO_HOME="$(getent passwd "${SUDO_USER}" | cut -d: -f6)"
fi

# git 检查：--git 模式必须 git 且工作区干净（pull 需要干净）；
# 默认模式用当前工作区代码 rsync，不 pull、不要求干净——git 仅用于展示版本（非 git 仓库则显示 unknown）。
GIT_BIN="$(command -v git || true)"
# git 操作一律以源码属主身份跑：
# ① 用到属主用户级 ignore（~/.config/git/ignore），status 视图与其 `git status` 一致
#    ——root 的 HOME=/root 读不到属主全局 ignore，会把 .claude/settings.local.json 等
#    误判为未跟踪，假报"工作区不干净"（即便属主自己 git status 是干净的）；
# ② 顺带免 dubious ownership；③ 避免以 root 写 .git/index 改属主、污染属主后续 git。
git_cmd() {
    [[ -n "${GIT_BIN}" ]] || return 1
    if [[ -n "${SUDO_USER:-}" && "${SUDO_USER}" != "root" ]]; then
        sudo -H -u "${SUDO_USER}" "${GIT_BIN}" -C "${SRC_DIR}" "$@"
    else
        "${GIT_BIN}" -C "${SRC_DIR}" "$@"
    fi
}
if [[ "${GIT_PULL}" -eq 1 ]]; then
    [[ -n "${GIT_BIN}" ]] || die "未找到 git（--git 模式需 git pull 拉取新码）"
    git_cmd rev-parse --is-inside-work-tree >/dev/null 2>&1 || die "${SRC_DIR} 不是 git 仓库（--git 模式需 git pull）"
    if [[ -n "$(git_cmd status --porcelain 2>/dev/null)" ]]; then
        die "源码工作区不干净，git pull 可能冲突。请先处理：cd ${SRC_DIR} && git status"
    fi
else
    [[ -n "${GIT_BIN}" ]] || warn "未找到 git（--git 未启用），版本号将显示 unknown"
fi

# sudo 重置 PATH（secure_path），需把原用户的 ~/.bun/bin 找回来（与 install.sh 同因）
if [[ -n "${SUDO_HOME}" && -d "${SUDO_HOME}/.bun/bin" ]]; then
    export PATH="${SUDO_HOME}/.bun/bin:${PATH}"
fi
command -v node  >/dev/null 2>&1 || die "未找到 node"
command -v bun   >/dev/null 2>&1 || die "未找到 bun（构建用）"
command -v rsync >/dev/null 2>&1 || die "未找到 rsync"
command -v curl  >/dev/null 2>&1 || die "未找到 curl"
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[[ "${NODE_MAJOR}" -ge "${NODE_MIN_MAJOR}" ]] || die "node 版本过低（${NODE_MAJOR}.x），需要 ${NODE_MIN_MAJOR}+"

# 必须已是 install.sh 装好的实例：unit 文件 + 代码目录 + env 三者齐备。
# 直接查 install.sh 落地的文件，不靠 `systemctl list-unit-files`——后者在 sudo 下
# 不可靠（实测出现过 service 明明 enabled/active 却被 grep 漏掉、假报"未安装"），
# 文件存在才是可靠判据；systemd 是否真认识该 unit，留给后面的 restart 去验证。
[[ -f "${UNIT_FILE}" ]]  || die "未检测到 install.sh 部署：systemd unit 不存在（${UNIT_FILE}）。update.sh 只升级已安装实例，请先 sudo ./scripts/install.sh"
[[ -d "${INSTALL_DIR}" ]] || die "未检测到 install.sh 部署：安装目录不存在（${INSTALL_DIR}）。请先 sudo ./scripts/install.sh"
[[ -f "${ENV_FILE}" ]]   || die "配置文件不存在：${ENV_FILE}（无法读取 PORT，请确认是 install.sh 部署）"

# 上次升级中断会残留 BACKUP_DIR 或 unit/env 备份：宁可停下让人确认，也不盲删/盲覆盖（可能是唯一恢复源）
if [[ -e "${BACKUP_DIR}" || -e "${BACKUP_TMP}" || -f "${UNIT_BAK}" || -f "${ENV_BAK}" ]]; then
    die "检测到上次升级的残留备份（${BACKUP_DIR} 或 ${UNIT_BAK}/${ENV_BAK}）。可能上次升级中断。请手动确认：若当前服务正常，sudo rm -rf ${BACKUP_DIR} ${BACKUP_TMP} ${UNIT_BAK} ${ENV_BAK} 后重试；若异常，从备份恢复。"
fi

# ---- 2. 从现有部署读参数（env 文件）----
PORT="$(env_val PORT)"
BASE_URL="$(env_val BASE_URL)"
DB_PATH="$(env_val DATABASE_PATH)"
if [[ -n "${DB_PATH}" ]]; then DATA_ROOT="$(dirname "${DB_PATH}")"; else DATA_ROOT="/var/lib/${SERVICE_NAME}"; fi
[[ "${PORT}" =~ ^[0-9]+$ ]] || die "从 ${ENV_FILE} 读到的 PORT 非法（${PORT:-空}），无法做 health 校验"

# 当前版本（升级后对比用）
OLD_REV="$(git_cmd rev-parse --short HEAD 2>/dev/null || echo unknown)"

# ---- 3. 打印参数 + 操作清单 + 确认 ----
echo
log "将原地升级 ${SERVICE_NAME}，读取到的部署参数："
printf '  源码克隆          %s\n' "${SRC_DIR}"
printf '  安装目录          %s\n' "${INSTALL_DIR}"
printf '  服务名            %s\n' "${SERVICE_NAME}"
printf '  运行用户          %s\n' "${SERVICE_USER}"
printf '  监听端口          %s\n' "${PORT}"
printf '  BASE_URL          %s\n' "${BASE_URL:-（env 未设）}"
printf '  数据目录          %s\n' "${DATA_ROOT}"
printf '  当前版本          %s\n' "${OLD_REV}"
echo
log "将执行的操作："
if [[ "${GIT_PULL}" -eq 1 ]]; then
    printf '  1) git pull 拉取最新代码\n'
else
    printf '  1) 用当前工作区代码（默认不 git pull；加 --git 才拉取）\n'
fi
printf '  2) 备份 %s → %s（unit / env 变更另有独立备份）\n' "${INSTALL_DIR}" "${BACKUP_DIR}"
printf '  3) rsync 新码到 %s（排除 data / node_modules / build / .git / .env）\n' "${INSTALL_DIR}"
printf '  4) chown root:root + bun install + build + 剥离 devDeps\n'
    printf '  5) 配置迁移（幂等）：env 补 ORIGIN / BODY_SIZE_LIMIT 达标校验 / 建日志目录 / 补 logrotate / 刷新 unit 模板 + daemon-reload\n'
printf '  6) systemctl restart %s\n' "${SERVICE_NAME}"
printf '  7) 轮询 /api/health（最多 %ss）；不过则自动回滚\n' "${HEALTH_WAIT}"
echo
warn "升级只动代码 ${INSTALL_DIR}，配置与数据不碰；万一失败脚本自动回滚到升级前状态。"
warn "仍建议升级前手动备份（双保险）："
printf '    sudo tar czf rr-backup.tar.gz %s %s\n' "${ENV_FILE}" "${DATA_ROOT}"
echo

if ! confirm "确认开始升级？（配置与数据不会改动）"; then
    log "已取消"
    exit 0
fi

# 确认通过后才挂回滚 trap：此前任何 die/cancel 都未改动 INSTALL_DIR，无需回滚
trap cleanup EXIT

# ---- 4. 拉取最新码（仅 --git 模式；默认模式直接用当前工作区代码）----
if [[ "${GIT_PULL}" -eq 1 ]]; then
    log "git pull 拉取最新代码"
    # --ff-only：部署克隆只应快进跟踪上游，避免意外产生 merge commit 把仓库搞乱
    if git_cmd pull --ff-only; then
        ok "代码已更新到最新"
    else
        die "git pull 失败（可能有本地提交、无上游跟踪或网络问题）。INSTALL_DIR 未改动，服务不受影响。请手动 cd ${SRC_DIR} && git pull 后重试"
    fi
else
    log "跳过 git pull（用当前工作区代码；加 --git 可先拉取）"
fi
NEW_REV="$(git_cmd rev-parse --short HEAD 2>/dev/null || echo unknown)"
if [[ "${GIT_PULL}" -eq 1 && "${NEW_REV}" != "${OLD_REV}" ]]; then
    log "版本变化：${OLD_REV} → ${NEW_REV}"
elif [[ "${GIT_PULL}" -eq 0 ]]; then
    log "使用当前工作区代码（HEAD ${NEW_REV}）"
else
    log "已是最新（${NEW_REV}），仍继续 rebuild 以保证构建一致"
fi

# ---- 5. 备份 INSTALL_DIR（整目录，覆盖 build + node_modules，兜底 ABI 坑）----
log "备份 ${INSTALL_DIR} → ${BACKUP_DIR}"
# cp 不改源；先写 .bak.tmp 再原子改名，.bak 仅在完整后才出现（失败不污染回滚判断）
rm -rf "${BACKUP_TMP}"
if ! cp -a "${INSTALL_DIR}" "${BACKUP_TMP}"; then
    rm -rf "${BACKUP_TMP}"
    die "备份失败（磁盘空间不足？）。INSTALL_DIR 未改动，服务不受影响。"
fi
mv "${BACKUP_TMP}" "${BACKUP_DIR}"
ok "备份完成（升级成功后自动删除）"

# ---- 6. rsync 新码到 INSTALL_DIR（排除产物/数据/版本控制；--delete 同步删除）----
log "rsync 新码到 ${INSTALL_DIR}"
rsync -a --delete \
    --exclude '/data' \
    --exclude '/node_modules' \
    --exclude '/apps/web/node_modules' \
    --exclude '/apps/web/build' \
    --exclude '/apps/web/.svelte-kit' \
    --exclude '/packages/shared/node_modules' \
    --exclude '/apps/mcp-bridge/node_modules' \
    --exclude '/apps/mcp-bridge/dist' \
    --exclude '/.git' \
    --exclude '/.env' \
    --exclude '/.env.local' \
    "${SRC_DIR}/" "${INSTALL_DIR}/"
ok "代码已同步"

# ---- 7. 归属 + 依赖 + 构建（与 install.sh 完全一致的 build 链路）----
log "chown -R root:root ${INSTALL_DIR}"
chown -R root:root "${INSTALL_DIR}"

BUN_BIN="$(command -v bun)"
# sudo 下 ~/.bun-install 不可写，统一用 /tmp 缓存（与 install.sh 同因）
export BUN_INSTALL_CACHE_DIR=/tmp/.bun-cache
mkdir -p "${BUN_INSTALL_CACHE_DIR}"

log "安装依赖（bun install）：${BUN_BIN}"
(cd "${INSTALL_DIR}" && "${BUN_BIN}" install)
ok "依赖已安装"

log "构建 web 应用（adapter-node 产物）"
(cd "${INSTALL_DIR}" && "${BUN_BIN}" --filter remote-reader-web build)
ok "构建完成"

# 剥离 devDependencies（vite build 已把 workspace 依赖内联到 build/server）
# 注意保留 bun.lock：删了它二次 install 会重新解析依赖树，结果随 registry 漂移且慢
log "整理生产 node_modules"
(cd "${INSTALL_DIR}" && rm -rf node_modules apps/web/node_modules packages/shared/node_modules apps/mcp-bridge/node_modules)
(cd "${INSTALL_DIR}" && "${BUN_BIN}" install --production)
ok "生产依赖就绪"

# bun 装出的 better-sqlite3 prebuilt 跟随 bun 内置 node 的 ABI，与生产 node 不匹配则服务起不来
# （实测 bun 1.3.x=ABI 137 vs node 22=ABI 127）。不匹配时自动换对应 ABI 的 prebuilt。
NODE_BIN="$(command -v node)"
if ! fix_better_sqlite3_abi "${INSTALL_DIR}" "${NODE_BIN}"; then
    die "better-sqlite3 ABI 自动修复失败，正在回滚…（可手动在 ${INSTALL_DIR} 内 npm rebuild better-sqlite3 后重试）"
fi

chown -R root:root "${INSTALL_DIR}"

# ---- 7.5 配置迁移（幂等，老部署升级到新特性所需；unit/env 先备份，失败可回滚）----
# a) env：老部署无 ORIGIN（新版启动校验必填，缺了服务起不来）→ 用 BASE_URL 补写
if ! grep -q '^ORIGIN=' "${ENV_FILE}" 2>/dev/null; then
    if [[ -n "${BASE_URL}" ]]; then
        cp -a "${ENV_FILE}" "${ENV_BAK}"
        # 先补换行：原文件末行无换行时直接追加会拼成无效变量
        printf '\nORIGIN=%s\n' "${BASE_URL}" >> "${ENV_FILE}"
        chown root:"${SERVICE_USER}" "${ENV_FILE}"
        chmod 640 "${ENV_FILE}"
        ok "env 已迁移：ORIGIN=${BASE_URL}（原文件备份 ${ENV_BAK}）"
    else
        warn "env 未设 ORIGIN 且 BASE_URL 为空，无法自动迁移——新版启动校验要求 ORIGIN，health 可能不过而回滚"
    fi
fi

# a2) env：老部署的 BODY_SIZE_LIMIT 多为 8M——图片支持后启动校验要求
#     ≥ max(MAX_UPLOAD_BYTES×1.5, MAX_IMAGE_BYTES×1.37×1.5)（默认 5M/10M 时 = 21548237B），
#     不足则服务起不来 → 按 env 实际值算下限，不足就提升到 MiB 取整值（有备份、可回滚）
MIG_MAX_UPLOAD="$(env_val MAX_UPLOAD_BYTES)"; [[ "${MIG_MAX_UPLOAD}" =~ ^[0-9]+$ ]] || MIG_MAX_UPLOAD=5242880
MIG_MAX_IMAGE="$(env_val MAX_IMAGE_BYTES)";  [[ "${MIG_MAX_IMAGE}" =~ ^[0-9]+$ ]] || MIG_MAX_IMAGE=10485760
MIG_NEED="$(required_body_size_limit "${MIG_MAX_UPLOAD}" "${MIG_MAX_IMAGE}")"
MIG_CURRENT="$(parse_size_bytes "$(env_val BODY_SIZE_LIMIT)")"
if [[ "${MIG_CURRENT}" -lt "${MIG_NEED}" ]]; then
    MIG_NEW="$(round_up_mib "${MIG_NEED}")"
    [[ -f "${ENV_BAK}" ]] || cp -a "${ENV_FILE}" "${ENV_BAK}"
    if grep -q '^BODY_SIZE_LIMIT=' "${ENV_FILE}"; then
        sed -i "s/^BODY_SIZE_LIMIT=.*/BODY_SIZE_LIMIT=${MIG_NEW}/" "${ENV_FILE}"
    else
        # 先补换行：原文件末行无换行时直接追加会拼成无效变量
        printf '\nBODY_SIZE_LIMIT=%s\n' "${MIG_NEW}" >> "${ENV_FILE}"
    fi
    chown root:"${SERVICE_USER}" "${ENV_FILE}"
    chmod 640 "${ENV_FILE}"
    ok "env 已迁移：BODY_SIZE_LIMIT=${MIG_NEW}（启动校验下限 ${MIG_NEED}，原文件备份 ${ENV_BAK}）"
fi

# b) 日志目录（幂等）：unit 的 append: 指向它，缺失则启动失败
mkdir -p "${LOG_DIR}"
chown "${SERVICE_USER}:${SERVICE_USER}" "${LOG_DIR}"
chmod 750 "${LOG_DIR}"

# c) logrotate：缺失则补（幂等）
if [[ ! -f "${LOGROTATE_FILE}" ]]; then
    LOG_DIR="${LOG_DIR}" bash "${SCRIPT_DIR}/gen-unit.sh" logrotate > "${LOGROTATE_FILE}"
    chmod 644 "${LOGROTATE_FILE}"
    ok "logrotate 已补写 ${LOGROTATE_FILE}"
fi

# d) unit：模板单源重新生成（与 install.sh 同源防漂移）；有差异才替换
cp -a "${UNIT_FILE}" "${UNIT_BAK}"
UNIT_TMP="$(mktemp)"
SERVICE_NAME="${SERVICE_NAME}" SERVICE_USER="${SERVICE_USER}" INSTALL_DIR="${INSTALL_DIR}" \
    ENV_FILE="${ENV_FILE}" DATA_DIR="${DATA_ROOT}" LOG_DIR="${LOG_DIR}" \
    NODE_BIN="$(command -v node)" \
    bash "${SCRIPT_DIR}/gen-unit.sh" unit > "${UNIT_TMP}"
if ! diff -q "${UNIT_BAK}" "${UNIT_TMP}" >/dev/null 2>&1; then
    install -m 644 "${UNIT_TMP}" "${UNIT_FILE}"
    ok "unit 已刷新（安全加固/日志落盘同步到最新模板）"
fi
rm -f "${UNIT_TMP}"
systemctl daemon-reload

# ---- 8. 重启 + health 校验（生产 node 跑 build/index.js，ABI 不匹配在此暴露）----
log "systemctl restart ${SERVICE_NAME}"
systemctl restart "${SERVICE_NAME}.service"

HEALTH_URL="http://127.0.0.1:${PORT}/api/health"
log "等待服务就绪（最多 ${HEALTH_WAIT}s）：${HEALTH_URL}"
HEALTH_OK=0
for i in $(seq 1 "${HEALTH_WAIT}"); do
    if curl -sf "${HEALTH_URL}" >/dev/null 2>&1; then
        ok "服务健康（${i}s）"
        HEALTH_OK=1
        break
    fi
    sleep 1
done

if [[ "${HEALTH_OK}" -ne 1 ]]; then
    # health 不过 = 生产二进制起不来。EXIT trap 会自动回滚；此处只负责给出排查指引。
    # better-sqlite3 ABI 不匹配已在剥离步骤后自动检测/修复，此处仍失败多为其他原因（端口/权限/配置）。
    warn "health 校验失败。排查：journalctl -u ${SERVICE_NAME} -n 100 --no-pager 或 sudo tail -n 100 ${LOG_DIR}/app.log"
    warn "若为 better-sqlite3 ABI 报错（ERR_DLOPEN_FAILED / NODE_MODULE_VERSION），自动修复可能未生效："
    warn "可在 ${INSTALL_DIR} 内 npm rebuild better-sqlite3 后重跑 update.sh。"
    die "升级未通过 health 校验，正在回滚…"
fi

# ---- 9. 成功：清理备份 + 总结 ----
rm -rf "${BACKUP_DIR}"
rm -f "${UNIT_BAK}" "${ENV_BAK}"
ok "已清理临时备份（${BACKUP_DIR} / unit / env）"
trap - EXIT

echo
printf '%s═══════════════════════════════════════════════════════════════%s\n' "${C_GREEN}" "${C_RESET}"
printf '%s Remote Reader 已原地升级%s\n' "${C_BOLD}${C_GREEN}" "${C_RESET}"
printf '%s═══════════════════════════════════════════════════════════════%s\n' "${C_GREEN}" "${C_RESET}"
echo
printf '  版本              %s → %s\n' "${OLD_REV}" "${NEW_REV}"
printf '  安装目录          %s\n' "${INSTALL_DIR}"
printf '  服务              %s（已重启，health 通过）\n' "${SERVICE_NAME}"
echo
printf '  %s已保留（未改动）%s\n' "${C_BOLD}" "${C_RESET}"
printf '    配置（含密钥）  %s\n' "${ENV_FILE}"
printf '                    → SESSION_SECRET 未变，已登录 session 不失效\n'
printf '    数据（DB/文档） %s\n' "${DATA_ROOT}"
echo
printf '  %s常用命令%s\n' "${C_BOLD}" "${C_RESET}"
printf '    看状态          systemctl status %s\n' "${SERVICE_NAME}"
printf '    跟踪日志        sudo tail -f %s/app.log\n' "${LOG_DIR}"
echo
