#!/bin/sh
set -e

# The data dir is a bind mount whose owner is decided by the host (often root on
# first `up`). chown it to node so the non-root server can write the SQLite DB
# and uploaded documents.
mkdir -p /app/data
chown -R node:node /app/data

# Drop privileges, then run the CMD as the node user.
exec runuser -u node -- "$@"
