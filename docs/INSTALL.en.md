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
BODY_SIZE_LIMIT=25165824 \
PORT=3000 \
node apps/web/build/index.js
```

Recommended: keep the process alive with systemd / pm2, behind an HTTPS reverse proxy (see §5).

> ⚠️ The entry point is `apps/web/build/index.js` (starts the HTTP server), **not** `build/handler.js` (which only exports the handler and cannot run standalone).
> ⚠️ **Do not start the service with `bun run`** — it will trigger the better-sqlite3 load failure.

---

## 4. Register first admin & generate API token

### 4.1 Register the first admin

After startup, visit `/register` and register with `INITIAL_INVITE_CODE` — **the first registered user automatically becomes `admin`**. Subsequent users register as `member`. Once the first admin exists, DB invite codes can be generated at `/settings/invites` to invite others (see the user guide); `INITIAL_INVITE_CODE` is a long-lived bootstrap code — rotate it after the initial batch of users.

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

The bridge has no native dependencies — `bun apps/mcp-bridge/src/index.ts` runs directly. **When registering the entry with an MCP client, always use an absolute path** — the working directory a client spawns the stdio process from is not guaranteed (some clients/launch paths do not pass `cwd`), and a relative path fails intermittently with `Module not found` (typical symptom: the tool works but the status page shows failed). Two configuration options (env takes precedence over file):

**Option 1: Environment variables** (recommended)

```bash
# Run from the repo root; $(pwd) expands to an absolute path at registration time (Windows PowerShell: "$PWD/...")
claude mcp add remote-reader bun "$(pwd)/apps/mcp-bridge/src/index.ts" \
  -e REMOTE_READER_URL=https://your-host \
  -e REMOTE_READER_TOKEN=rr_xxx
```

**Option 2: Configuration file**

Write `~/.config/remote-reader/config.json` (or `$XDG_CONFIG_HOME/remote-reader/config.json`):

```json
{ "baseUrl": "https://your-host", "token": "rr_xxx" }
```

Then just register the command: `claude mcp add remote-reader bun "$(pwd)/apps/mcp-bridge/src/index.ts"`.

**Other MCP clients** (Cursor / Cline / Windsurf / opencode / ZCode and any client that reads a config file directly): use the standard `mcpServers` JSON with an absolute entry path (ZCode nests the same fields under `mcp.servers` in `~/.zcode/cli/config.json`; if a GUI-launched client does not inherit the shell PATH, use an absolute path to the bun executable as `command` too):

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

> **With cold/hot tiering enabled** (`OBJECT_STORE_*` configured): content of cold docs (unaccessed beyond `COLD_TIER_AFTER_DAYS`) lives **only in the object storage bucket** (under the `archive/` prefix) — the `data/` backup above no longer includes it. Include the bucket in your backup strategy (e.g. Qiniu cross-region sync / lifecycle export), otherwise the backup is incomplete.

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
| `INITIAL_INVITE_CODE` | (none) | Bootstrap invite code: required to register the first admin, valid long-term; afterwards use DB invite codes from `/settings/invites` |
| `DATABASE_PATH` | `./data/app.db` | SQLite path (relative to the runtime cwd) |
| `DATA_DIR` | `./data/documents` | Root directory where documents persist to disk |
| `BASE_URL` | `http://localhost:5173` | External URL prefix used when generating share links |
| `BRIDGE_REPO_URL` | `https://github.com/earneet/remote-reader` | Bridge source repo URL shown in the login-page agent guide (change for custom forks) |
| `MAX_UPLOAD_BYTES` | `5242880` (5MB) | Per-document size cap |
| `BODY_SIZE_LIMIT` | adapter-node default 512K | **Bytes (numeric)**, gateway-layer body cap. Production startup check (fail-fast): must be ≥ **max**(`MAX_UPLOAD_BYTES`×1.5, `MAX_IMAGE_BYTES`×1.37×1.5) — image relay bodies are base64 (~×1.37) plus JSON wrapping |
| `IMAGE_STORE_BACKEND` | `local` | Image storage backend: `local` (blobs under DATA_DIR, served via the `/s/<token>/i/<name>` login-free proxy) / `s3` (shares the `OBJECT_STORE_*` config with cold tiering; init returns a presigned PUT for direct CDN upload, viewing uses presigned GET links) |
| `MAX_IMAGE_BYTES` | `10485760` (10MB) | Per-image size cap (double-checked at init preflight and by relay byte measurement) |
| `IMAGE_SIGNED_URL_TTL` | `3600` (seconds) | Minimum validity of presigned viewing URLs on the s3 backend (bucket-aligned cache reuse; URLs are byte-identical within a bucket to hit browser cache) |
| `IMAGE_PROXY_ALL` | `0` | `1` = force server-side proxying even on the s3 backend (for intranet deployments with no outbound CDN access); the `local` backend always proxies |
| `IMAGES_META_RATE_LIMIT_MAX` | `120` | Independent light bucket for the init/confirm metadata endpoints (per token, same `RATE_LIMIT_WINDOW_MS` window); image byte relay uses an independent bucket sized like `RATE_LIMIT_MAX` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `60` / `60000` | Per-token upload rate limit |
| `LOGIN_RATE_LIMIT_MAX` | `10` | Login attempts per email (same window) |
| `SESSION_MAX_AGE` | `2592000` (30 days, seconds) | Session lifetime |
| `PORT` / `HOST` / `ORIGIN` | `3000` / `0.0.0.0` / — | adapter-node listen address and origin validation |
| `NODE_ENV` | — | Set to `production` to enable secure cookies and enforce SESSION_SECRET |
| `OBJECT_STORE_ENDPOINT` / `OBJECT_STORE_REGION` / `OBJECT_STORE_BUCKET` | — (all empty = off) | S3-compatible object store for cold/hot tiering (Qiniu example: `https://s3.<region>.qiniucs.com`); the 5 vars must be **all set or all empty** — partial config fails startup with the missing names |
| `OBJECT_STORE_ACCESS_KEY_ID` / `OBJECT_STORE_SECRET_ACCESS_KEY` | — | Object store credentials (server-side env only, never stored in DB) |
| `OBJECT_STORE_FORCE_PATH_STYLE` | `false` | Path-style addressing (self-hosted MinIO needs `true`; Qiniu/AWS/R2 keep false) |
| `COLD_TIER_AFTER_DAYS` | `30` | Cold threshold: docs unaccessed & unupdated for N days auto-archive to object storage (local keeps metadata only; opening a doc rewarms it automatically — cold docs stay viewable and title-searchable) |

> Numeric variables are parsed strictly by `envInt`: non-positive integers throw at module load (fail-closed), with no silent fallback.

---

## 9. Troubleshooting

| Symptom | What to check |
|---|---|
| Production startup reports `SESSION_SECRET must be set in production` | Set `SESSION_SECRET` (a long random string) |
| Production startup reports BODY_SIZE_LIMIT must be ≥ max(...) | Use a byte count ≥ `max(MAX_UPLOAD_BYTES×1.5, MAX_IMAGE_BYTES×1.37×1.5)` (with 5M docs + 10M images the floor is 21548237, e.g. `25165824`); on systemd deployments `update.sh` migrates it automatically |
| `better-sqlite3 ... not supported` / `ERR_DLOPEN_FAILED` | Starting with `bun run` fails to load it — switch to `node apps/web/build/index.js`; if node reports a `NODE_MODULE_VERSION` mismatch: bun's prebuilt follows bun's bundled-node ABI — `install.sh`/`update.sh` auto-detect and swap in the matching-ABI prebuilt, for manual deploys run `npm rebuild better-sqlite3` at the repo root |
| Upload >512K returns 413 but you're sure it's < `MAX_UPLOAD_BYTES` | `BODY_SIZE_LIMIT` is smaller than the content size (adapter-node default is only 512K) |
| Invite code rejected at registration | Bootstrap code: verify `INITIAL_INVITE_CODE` matches what was set at startup; DB code: may have expired or been revoked (check `/settings/invites`) |
| seed-token reports `Cannot find package 'better-sqlite3'` | Run it from the **repository root** (not apps/web) |
| Docker container `unhealthy` | `docker compose logs web`; usually a missing port/config/env |
| Share link won't open / 404 | Share token revoked or document deleted; have the Agent re-upload |
| Port 5173 already taken | dev auto-switches to 5174; or change `--port` |
