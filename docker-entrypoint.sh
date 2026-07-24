#!/bin/bash
set -euo pipefail

# The data dir is a bind mount whose owner is decided by the host (often root on
# first `up`). chown it to node so the non-root server can write the SQLite DB
# and uploaded documents.
mkdir -p /app/data
# 仅修正非 node 所属的条目：重启时大部分已是 node，find 过滤后跳过 chown 系统调用，
# 文档量大时比重启遍历全树 chown -R 显著更快（首次仍会处理全 root 的树）。
find /app/data ! -user node -exec chown node:node {} + 2>/dev/null || echo '[entrypoint] chown 部分失败，继续启动' >&2

# Drop privileges, then run the CMD as the node user.
exec runuser -u node -- "$@"
