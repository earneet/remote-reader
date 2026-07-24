#!/usr/bin/env bash
# Remote Reader 一键卸载(install.sh 的逆操作,Ubuntu/Debian + systemd)
#
# 用法(在项目根目录):
#   sudo ./scripts/uninstall.sh              # 停服 + 删 unit/代码/配置,保留数据
#   sudo ./scripts/uninstall.sh --purge      # 连数据目录一起删(删前二次确认)
#   sudo ./scripts/uninstall.sh --yes        # 跳过所有确认(自动化)
#
# 可用环境变量覆盖(须与 install.sh 安装时一致):
#   SERVICE_NAME=remote-reader               systemd unit 名
#   SERVICE_USER=remote-reader               运行专用系统用户
#   INSTALL_DIR=/opt/remote-reader           代码目录
#   DATA_DIR=/var/lib/remote-reader          数据目录(保留/删除目标)
set -euo pipefail

# ---- 默认参数(与 install.sh 完全一致,保证能精准定位)----
SERVICE_NAME="${SERVICE_NAME:-remote-reader}"
SERVICE_USER="${SERVICE_USER:-remote-reader}"
INSTALL_DIR="${INSTALL_DIR:-/opt/remote-reader}"
DATA_DIR="${DATA_DIR:-/var/lib/remote-reader}"
CONFIG_DIR="/etc/${SERVICE_NAME}"
UNIT_FILE="/etc/systemd/system/${SERVICE_NAME}.service"
ENV_FILE="${CONFIG_DIR}/env"

# ---- 解析命令行参数 ----
PURGE=0
ASSUME_YES=0
usage() {
    cat <<EOF
用法: sudo ./scripts/uninstall.sh [--purge] [-y|--yes] [-h|--help]
  --purge      连数据目录(${DATA_DIR})一起永久删除(删前单独确认)
  -y, --yes    跳过所有确认(自动化场景)
  -h, --help   显示本帮助
默认(无 --purge):停服务 + 删 unit/代码/配置,保留 ${DATA_DIR} 数据。
环境变量覆盖: SERVICE_NAME / SERVICE_USER / INSTALL_DIR / DATA_DIR
EOF
}
while [[ $# -gt 0 ]]; do
    case "$1" in
        --purge) PURGE=1; shift ;;
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

log()  { printf '%s[%s]%s %s\n' "${C_BLUE}" "uninstall" "${C_RESET}" "$*"; }
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

# ---- 1. 前置检查 ----
[[ $EUID -eq 0 ]] || die "需要 root 权限,请用 sudo 运行:sudo $0"
[[ -d /run/systemd/system ]] || die "未检测到 systemd,本脚本仅支持 systemd 发行版"

# 拒绝危险路径:卸载要 rm -rf,DATA_DIR/INSTALL_DIR 为空或根目录会酿成灾难
[[ -n "${SERVICE_NAME}" ]] || die "SERVICE_NAME 不能为空"
[[ -n "${INSTALL_DIR}" && "${INSTALL_DIR}" != "/" ]] || die "INSTALL_DIR 非法(${INSTALL_DIR:-空}),拒绝执行"
[[ -n "${DATA_DIR}" && "${DATA_DIR}" != "/" ]] || die "DATA_DIR 非法(${DATA_DIR:-空}),拒绝执行"

# ---- 2. 存在性检测(unit / 代码 / 数据 / 用户 全无残留 → 幂等退出)----
installed=0
if systemctl list-unit-files 2>/dev/null | grep -q "^${SERVICE_NAME}\.service"; then installed=1; fi
if [[ -f "${UNIT_FILE}" ]]; then installed=1; fi
if [[ -d "${INSTALL_DIR}" ]]; then installed=1; fi
if [[ -d "${DATA_DIR}" ]]; then installed=1; fi
if [[ "${installed}" -eq 0 ]]; then
    warn "未检测到 ${SERVICE_NAME} 的安装(unit/代码/数据均不存在),无需卸载。"
    exit 0
fi

# ---- 3. 读取旧 PORT(若 env 还在),结尾用于精确提示 ufw ----
PORT_HINT=""
if [[ -f "${ENV_FILE}" ]]; then
    PORT_HINT="$(awk -F= '/^PORT=/{print $2; exit}' "${ENV_FILE}" 2>/dev/null | tr -d '[:space:]' || true)"
fi

# ---- 4. 打印操作清单 + 主确认 ----
echo
log "将卸载 ${SERVICE_NAME},操作清单:"
printf '  服务名            %s\n' "${SERVICE_NAME}"
printf '  运行用户          %s\n' "${SERVICE_USER}"
printf '  代码目录(删)     %s\n' "${INSTALL_DIR}"
printf '  配置目录(删)     %s\n' "${CONFIG_DIR}"
printf '  systemd unit(删) %s\n' "${UNIT_FILE}"
if [[ "${PURGE}" -eq 1 ]]; then
    printf '  %s数据目录(删)     %s%s\n' "${C_RED}" "${DATA_DIR}" "${C_RESET}"
else
    printf '  %s数据目录(保留)   %s%s\n' "${C_GREEN}" "${DATA_DIR}" "${C_RESET}"
fi
echo

if ! confirm "确认开始卸载?"; then
    log "已取消"
    exit 0
fi

# --purge 模式:数据删除前单独二次确认;取消则降级为保留数据继续
if [[ "${PURGE}" -eq 1 ]] && ! confirm "${C_RED}⚠ --purge 将永久删除 ${DATA_DIR}(DB + 已上传文档),不可恢复,确认?${C_RESET}"; then
    warn "已取消数据删除,降级为保留数据模式继续"
    PURGE=0
fi

# ---- 5. 执行清理(每步容错,半残状态也能清干净)----
log "停止 + 禁用服务"
systemctl stop "${SERVICE_NAME}.service" 2>/dev/null || true
systemctl disable "${SERVICE_NAME}.service" 2>/dev/null || true
ok "服务已停止/禁用"

log "删除 systemd unit"
rm -f "${UNIT_FILE}"
systemctl daemon-reload
systemctl reset-failed "${SERVICE_NAME}.service" 2>/dev/null || true
ok "unit 已删除 + daemon-reload"

log "删除代码 + 配置"
rm -rf "${INSTALL_DIR}" "${CONFIG_DIR}"
ok "代码/配置已删除"

if [[ "${PURGE}" -eq 1 ]]; then
    log "删除数据目录 ${DATA_DIR}"
    rm -rf "${DATA_DIR}"
    ok "数据已删除"
else
    warn "数据目录已保留: ${DATA_DIR}"
fi

log "删除系统用户 ${SERVICE_USER}"
# 永不加 -r:install.sh 把用户 home 指向 DATA_DIR,-r 会顺带删数据;
# 数据删除须由上面的 --purge 单一入口控制,这里只删用户身份。
if id -u "${SERVICE_USER}" >/dev/null 2>&1; then
    userdel "${SERVICE_USER}" 2>/dev/null || warn "用户 ${SERVICE_USER} 删除失败(可能仍有残留进程),可稍后手动 userdel"
    ok "用户已删除"
else
    warn "用户 ${SERVICE_USER} 不存在,跳过"
fi

# ---- 6. ufw 提示(只读不删:install.sh 当初也没动 ufw,规则可能是用户其他用途)----
if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "active"; then
    echo
    if [[ -n "${PORT_HINT}" ]]; then
        warn "ufw 处于启用状态,若曾为该服务放行端口 ${PORT_HINT},手动删除:"
        printf '    sudo ufw delete allow %s\n' "${PORT_HINT}"
    else
        warn "ufw 处于启用状态,若曾为该服务放行端口,记得手动 ufw delete allow <端口>"
    fi
fi

# ---- 7. 总结 ----
echo
printf '%s═══════════════════════════════════════════════════════════════%s\n' "${C_GREEN}" "${C_RESET}"
printf '%s Remote Reader 已卸载%s\n' "${C_BOLD}${C_GREEN}" "${C_RESET}"
printf '%s═══════════════════════════════════════════════════════════════%s\n' "${C_GREEN}" "${C_RESET}"
echo
if [[ "${PURGE}" -eq 1 ]]; then
    printf '  数据              已永久删除(%s)\n' "${DATA_DIR}"
else
    printf '  %s数据已保留%s        %s\n' "${C_YELLOW}" "${C_RESET}" "${DATA_DIR}"
    printf '                    (含 DB + 文档;重装时复用旧 SESSION_SECRET 可保已签发 session)\n'
fi
printf '  systemd unit      已删除 + daemon-reload\n'
printf '  代码 / 配置       已删除\n'
printf '  系统用户          %s 已删除\n' "${SERVICE_USER}"
echo
