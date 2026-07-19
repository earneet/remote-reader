# Installation Guide · Remote Reader

> English | [中文](./INSTALL.md)

This guide covers the full path from a clean machine to production ops. Jump by role: to get it running fast read §1–§2; for a complete production deployment read §2–§4.

---

## 1. Prerequisites

| Component | Version | Purpose |
|---|---|---|
| Docker + Docker Compose | any modern version | Option 1 (recommended) |
| Node.js | ≥ 20 (production) | Option 2 |
| Bun | ≥ 1.0 | Package manager + build host for Option 2 |
| SQLite | embedded via better-sqlite3 | No separate install needed |

**Runtime split (important)**: `better-sqlite3` is a native addon and **fails to load when run directly under bun** (only works under `bun + vite dev/build`). Therefore run tests with vitest (under node), use bun for dev/build/install, and **run production with `node apps/web/build/index.js`**. The Docker image already handles this for you.

---

## 2. Option 1: Docker Compose (recommended for production)

Image features: multi-stage build, prod-only node_modules (~423MB), **non-root runtime** (uid 1000), HEALTHCHECK.

### 2.1 Prepare configuration

```bash
git clone <repo> && cd remote-reader
cp .env.example .env            # At minimum change these two:
```

Edit `.env`:

```bash
SESSION_SECRET=<a long random string of 32+ bytes>   # Required in production; missing fails fast
INITIAL_INVITE_CODE=<your invite code>               # Needed to register the first admin
```

Optional overrides (`docker-compose.yml` ships with sane defaults):

```yaml
environment:
  - DATABASE_PATH=/app/data/app.db     # SQLite path
  - DATA_DIR=/app/data/documents        # Root directory where documents persist to disk
  - BASE_URL=http://localhost:3000      # External URL prefix used when generating share links (change to your domain after deploy)
```

### 2.2 Start

```bash
docker compose up -d --build
docker compose logs -f web    # "listening" means it's ready
```

Visit `http://localhost:3000`; you should be 302-redirected to `/login`.

### 2.3 Data persistence

`docker-compose.yml` mounts the host's `./data` into the container at `/app/data`. The container runs as the **node user (uid 1000)**; `docker-entrypoint.sh` `chown`s the data directory as root at startup and then drops privileges via `runuser`, so the host `./data` is writable regardless of its initial owner. `./data` contains the database and documents — **never commit it** (already gitignored); back it up as confidential material.

### 2.4 Health check

The image includes a built-in `HEALTHCHECK` (node fetch on `/`, 30s interval). `docker compose ps` showing `(healthy)` means the service is alive.

### 2.5 Update the image

```bash
git pull
docker compose up -d --build    # Rebuild the image and rolling-restart
```

Schema changes require an additional migration run (see §6).

---

## 3. Option 2: Manual node deployment

Suitable when you don't use Docker, or want direct control of the process (systemd/pm2).

### 3.1 Build

```bash
bun install
bun --filter remote-reader-web build       # Output goes to apps/web/build/
bun --filter remote-reader-web db:migrate  # Generates data/app.db
```

### 3.2 Start (node)

```bash
SESSION_SECRET=<long random string> \
INITIAL_INVITE_CODE=<invite code> \
DATABASE_PATH=./data/app.db \
DATA_DIR=./data/documents \
BASE_URL=https://your-domain \
ORIGIN=https://your-domain \
BODY_SIZE_LIMIT=8388608 \
PORT=3000 \
node apps/web/build/index.js
```

Recommended: keep the process alive with systemd / pm2, behind an HTTPS reverse proxy (see §5).

> ⚠️ The entry point is `apps/web/build/index.js` (starts the HTTP server), **not** `build/handler.js` (which only exports the handler and cannot run standalone).
> ⚠️ **Do not start the service with `bun run`** — it will trigger the better-sqlite3 load failure.

---

## 4. Register first admin & generate API token

### 4.1 Register the first admin

After startup, visit `/register` and register with `INITIAL_INVITE_CODE` — **the first registered user automatically becomes `admin`**. Subsequent users register as `member`. Rotating `INITIAL_INVITE_CODE` after the initial batch of users is recommended.

### 4.2 Generate an API token (for the Agent)

Two options:

**UI** (recommended): Log in → Settings → API Token → New. The plaintext token is **shown only once** — copy and save it immediately.

**Script**:

```bash
node scripts/seed-token.mjs <email of an already-registered user>
# → TOKEN=rr_... (plaintext shown only once)
```

> The script must be run from the **repository root** (it uses `createRequire` to locate dependencies).

Only the sha256 hash of the token is stored in the database; **if the plaintext is lost you must regenerate it**. To revoke: one click in the UI, or edit the database manually.

---

## 5. Reverse proxy & HTTPS

Production **must use HTTPS** (the `secure` flag on the session cookie depends on it). Put nginx / caddy in front:

**nginx example**:

```nginx
server {
    listen 443 ssl http2;
    server_name your-domain;
    # ssl_certificate ...

    client_max_body_size 8m;     # Must be > MAX_UPLOAD_BYTES

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

**caddy example** (automatic HTTPS):

```
your-domain {
    reverse_proxy 127.0.0.1:3000
    request_body { max_size 8MB }
}
```

Remember to update `BASE_URL` / `ORIGIN` to `https://your-domain`.

---

## 6. MCP bridge configuration (Agent uploads)

The bridge has no native dependencies — `bun apps/mcp-bridge/src/index.ts` runs directly. Two configuration options (env takes precedence over file):

**Option 1: Environment variables** (recommended)

```bash
claude mcp add remote-reader bun apps/mcp-bridge/src/index.ts \
  -e REMOTE_READER_URL=https://your-host \
  -e REMOTE_READER_TOKEN=rr_xxx
```

**Option 2: Configuration file**

Write `~/.config/remote-reader/config.json` (or `$XDG_CONFIG_HOME/remote-reader/config.json`):

```json
{ "baseUrl": "https://your-host", "token": "rr_xxx" }
```

Then just register the command: `claude mcp add remote-reader bun apps/mcp-bridge/src/index.ts`.

If configuration is missing (neither env nor file present) the bridge exits at startup (exit 1) and prints guidance. Once configured, the Agent calls `upload_document({ name, content, path? })` and gets back a share link.

> Debugging: `npx @modelcontextprotocol/inspector bun apps/mcp-bridge/src/index.ts`, or `bun apps/mcp-bridge/scripts/smoke-client.ts <url> <token>` (requires the web app to be running).

---

## 7. Backup & upgrade

### 7.1 Backup

The `./data` directory contains everything (SQLite database + document source):

```bash
# Stop the service, or hot backup
tar czf backup-$(date +%F).tar.gz data/
# Or back up only the database
sqlite3 data/app.db ".backup data/backup-$(date +%F).db"
```

### 7.2 Upgrade / migrate

After a schema change, regenerate and apply the migration:

```bash
bun --filter remote-reader-web db:generate   # Generate the new migration SQL
bun --filter remote-reader-web db:migrate    # Apply (run during a maintenance window with the service stopped in production)
```

Docker deployments: migrations are already executed at image build time; a schema change requires rebuilding the image (`docker compose up -d --build`).

---

## 8. Configuration reference (environment variables)

| Variable | Default | Description |
|---|---|---|
| `SESSION_SECRET` | (none, required in production) | Session signing key; missing in production fails fast, missing in dev uses an insecure default and warns |
| `INITIAL_INVITE_CODE` | (none) | Invite code required to register |
| `DATABASE_PATH` | `./data/app.db` | SQLite path (relative to the runtime cwd) |
| `DATA_DIR` | `./data/documents` | Root directory where documents persist to disk |
| `BASE_URL` | `http://localhost:5173` | External URL prefix used when generating share links |
| `MAX_UPLOAD_BYTES` | `5242880` (5MB) | Per-document size cap |
| `BODY_SIZE_LIMIT` | adapter-node default 512K | **Bytes (numeric)**, gateway-layer body cap; must be > `MAX_UPLOAD_BYTES` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `60` / `60000` | Per-token upload rate limit |
| `LOGIN_RATE_LIMIT_MAX` | `10` | Login attempts per email (same window) |
| `SESSION_MAX_AGE` | `2592000` (30 days, seconds) | Session lifetime |
| `PORT` / `HOST` / `ORIGIN` | `3000` / `0.0.0.0` / — | adapter-node listen address and origin validation |
| `NODE_ENV` | — | Set to `production` to enable secure cookies and enforce SESSION_SECRET |

> Numeric variables are parsed strictly by `envInt`: non-positive integers throw at module load (fail-closed), with no silent fallback.

---

## 9. Troubleshooting

| Symptom | What to check |
|---|---|
| Production startup reports `SESSION_SECRET must be set in production` | Set `SESSION_SECRET` (a long random string) |
| Production startup reports `Invalid BODY_SIZE_LIMIT` | Use a byte count (e.g. `8388608`), no unit |
| `better-sqlite3 ... not supported` / `ERR_DLOPEN_FAILED` | You're starting the service with `bun run` — switch to `node apps/web/build/index.js` |
| Upload >512K returns 413 but you're sure it's < `MAX_UPLOAD_BYTES` | `BODY_SIZE_LIMIT` is smaller than the content size (adapter-node default is only 512K) |
| Invite code rejected at registration | Verify `INITIAL_INVITE_CODE` matches what was set at startup |
| seed-token reports `Cannot find package 'better-sqlite3'` | Run it from the **repository root** (not apps/web) |
| Docker container `unhealthy` | `docker compose logs web`; usually a missing port/config/env |
| Share link won't open / 404 | Share token revoked or document deleted; have the Agent re-upload |
| Port 5173 already taken | dev auto-switches to 5174; or change `--port` |
