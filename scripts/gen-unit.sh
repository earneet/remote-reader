#!/usr/bin/env bash
# systemd unit 与 logrotate 配置的唯一生成源——install.sh（初始部署）与 update.sh（原地升级）
# 共用，防止两处模板漂移（unit 含 17 项加固，漂移即安全语义分叉）。
#
# 用法（参数一律经环境变量传入，stdout 输出文件内容）：
#   scripts/gen-unit.sh unit      # 生成 systemd unit 内容
#   scripts/gen-unit.sh logrotate # 生成 /etc/logrotate.d 配置内容
#
# 所需环境变量：SERVICE_NAME SERVICE_USER INSTALL_DIR ENV_FILE DATA_DIR LOG_DIR NODE_BIN
set -euo pipefail

# 各子命令所需变量分别校验：unit 全量；logrotate 只需 LOG_DIR
case "${1:-}" in
    unit)
        for v in SERVICE_NAME SERVICE_USER INSTALL_DIR ENV_FILE DATA_DIR LOG_DIR NODE_BIN; do
            [[ -n "${!v:-}" ]] || { printf 'gen-unit: 缺少环境变量 %s\n' "$v" >&2; exit 1; }
        done
        ;;
    logrotate)
        [[ -n "${LOG_DIR:-}" ]] || { printf 'gen-unit: 缺少环境变量 LOG_DIR\n' >&2; exit 1; }
        ;;
esac

case "${1:-}" in
    unit)
        cat <<EOF
[Unit]
Description=Remote Reader (Markdown delivery for AI agents)
Documentation=https://github.com/earneet/remote-reader
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${SERVICE_USER}
Group=${SERVICE_USER}
WorkingDirectory=${INSTALL_DIR}
EnvironmentFile=${ENV_FILE}
ExecStart=${NODE_BIN} apps/web/build/index.js
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
# 仅允许写数据目录与日志目录；代码/配置只读
ReadWritePaths=${DATA_DIR} ${LOG_DIR}
BindReadOnlyPaths=${INSTALL_DIR}

# 日志落盘 ${LOG_DIR}/app.log（访问+错误合流，按时间序排障最直观）；
# journald 不再收应用日志（append: 与 journal 互斥），logrotate copytruncate 兜轮转。
# append: 需 systemd >= 240（2020 年起的 Ubuntu/Debian 均满足）
StandardOutput=append:${LOG_DIR}/app.log
StandardError=append:${LOG_DIR}/app.log

# 资源限制
LimitNOFILE=65536
MemoryMax=512M
TasksMax=256

[Install]
WantedBy=multi-user.target
EOF
        ;;
    logrotate)
        cat <<EOF
${LOG_DIR}/app.log {
    daily
    rotate 14
    compress
    delaycompress
    missingok
    notifempty
    copytruncate
}
EOF
        ;;
    *)
        printf '用法: %s {unit|logrotate}\n' "$0" >&2
        exit 1
        ;;
esac
