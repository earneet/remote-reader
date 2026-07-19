# Remote Reader · User Guide

> English | [中文](./USER_GUIDE.md)

This guide is organized by role: **Deployer / Administrator**, **Agent Operator**, **Reader**. Jump to the section you need.

> Status: Sub-plan 1 (Web core) + Sub-plan 2 (Local MCP bridge) + Sub-plan 3 (Admin UI + Markdown enhancements + Docker) **all implemented and merged to master**. For full deployment steps, see [Installation](./INSTALL.en.md).

---

## 0. Quick Start (5-minute local trial)

```bash
git clone <repo> && cd remote_reader
cp .env.example .env            # At minimum change SESSION_SECRET and INITIAL_INVITE_CODE
```

**Option 1: Docker (recommended)**

```bash
docker compose up -d --build    # → http://localhost:3000
```

**Option 2: Local dev**

```bash
bun install
bun --filter remote-reader-web db:migrate   # Generates data/app.db
bun --filter remote-reader-web dev          # http://localhost:5173 (falls back to 5174 if taken)
```

Register the first user and upload a document:

```bash
# 1) Open /register in a browser and register with the INITIAL_INVITE_CODE from .env (first user becomes admin automatically)

# 2) Generate an API token for this user (either of the two options)
#    - UI: Log in → Settings → API Token → New (plaintext is shown only once)
#    - Script (run from the repo root):
node scripts/seed-token.mjs your@email.com
# Output: TOKEN=rr_xxxxxxxx...   ← shown only once, save immediately

# 3) Upload a markdown document
TOKEN="rr_xxxxxxxx..."
curl -X POST http://localhost:3000/api/v1/documents \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"hello.md","content":"# 你好\n\n这是 **Remote Reader**.\n\n```ts\nconst x: number = 1;\n```","path":"demo"}'
# Returns {"id":"...","url":"http://localhost:3000/s/<token>"}

# 4) Open the returned url — login-free, rendered immediately (heading, bold, code highlighting)
```

---

## 1. Deployer / Administrator

For full deployment (Docker / manual node / reverse proxy / HTTPS / backup / upgrade migration), see [Installation](./INSTALL.en.md). This section focuses on day-to-day admin operations.

### 1.1 Register first admin

After startup, visit `/register` and register with `INITIAL_INVITE_CODE` — **the first registered user automatically becomes `admin`**. Subsequently registered users become `member`. It is recommended to rotate `INITIAL_INVITE_CODE` after the first batch of users has registered.

### 1.2 API token management ✅

**UI** (recommended): Log in → Settings → API Token. You can create (with one-time plaintext reveal and copy) and revoke tokens. A revoked token is invalidated immediately.

**Script**:

```bash
node scripts/seed-token.mjs <email of an existing user>     # Must be run from the repo root
# → TOKEN=rr_... (plaintext shown only once)
```

Only the sha256 hash of the token is stored in the database; **if you lose the plaintext you must regenerate it**.

### 1.3 Database migration

After schema changes, regenerate and apply migrations:

```bash
bun --filter remote-reader-web db:generate   # Generate new migration SQL
bun --filter remote-reader-web db:migrate    # Apply (run during downtime or a maintenance window before production rollout)
```

Docker deployments: migrations are already applied during image build; schema changes require rebuilding the image (`docker compose up -d --build`).

---

## 2. Agent Operator

### 2.1 Recommended: Local MCP bridge ✅

The bridge (`apps/mcp-bridge`) is a stdio MCP server that exposes the `upload_document` tool, holds the token locally, and forwards requests to the Web API. Agents need not write HTTP by hand. The bridge has no native dependencies — `bun apps/mcp-bridge/src/index.ts` runs directly.

Two configuration options (env takes precedence over file):

**Option 1: Environment variables** (recommended, passed in one shot by the MCP client)

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

If configuration is missing (neither env nor file), the bridge exits at startup (exit 1) and prints guidance. Once configured, the Agent calls `upload_document({ name, content, path? })` and receives a tool result like `Uploaded (id=...). View link: https://.../s/<token>`.

> Debugging: `npx @modelcontextprotocol/inspector bun apps/mcp-bridge/src/index.ts`, or `bun apps/mcp-bridge/scripts/smoke-client.ts <url> <token>` (requires the Web app to be running).

### 2.2 Alternative: Direct HTTP API ✅

If you don't use the bridge, you can call the upload API directly:

```
POST /api/v1/documents
Header: Authorization: Bearer <API_TOKEN>
        Content-Type: application/json
Body:   { "name": "<filename>", "content": "<markdown body>", "path": "<optional directory path>" }

Response 200: { "id": "...", "url": "https://<host>/s/<share-token>" }
```

**Parameters**:

- `name` (required): filename, e.g. `weekly.md`. Passed through path-safety filtering (rejects `..` / absolute paths / `\` / `:`, etc.).
- `content` (required): markdown body (UTF-8 string).
- `path` (optional): POSIX-style directory prefix, e.g. `reports/2026-07`. Filtered the same way.

### 2.3 Idempotent semantics (important)

Documents are located by `(owner, path, name)`, and the sha256 of `content` decides the action:

| Case | Behavior | Return value |
|---|---|---|
| No document at that location | Create + persist to disk + generate share link | `{ id, url }` (new) |
| Exists, identical content | **Does not write to disk, does not update timestamp** | `{ id, url }` (same) |
| Exists, different content | Overwrite on disk + update hash/size | `{ id, url }` (**id and url unchanged**) |

→ **The view link for the same document remains stable over time**; when the content updates, the link stays the same and points to the latest version automatically. Agents can safely re-upload.

### 2.4 Error codes

| HTTP | Meaning | Handling |
|---|---|---|
| 200 | Upload succeeded | Send the `url` to the user |
| 400 | Invalid request body / JSON parse failure / `name` or `path` contains illegal characters (including `..` traversal) | Fix parameters and retry; do **not** retry as a server fault |
| 401 | Missing token, or token invalid/revoked | Check `Authorization: Bearer` |
| 413 | Content exceeds `MAX_UPLOAD_BYTES` (default 5MB) | Split or trim the document |
| 429 | Rate limit triggered (default 60/min per token) | Retry with backoff |

---

## 3. Reader

### 3.1 View shared document ✅

When you receive a link from an Agent (e.g. `https://<host>/s/<token>`), **just click it** — no registration or login required, you'll see the rendered document immediately (headings, bold, lists, GFM tables, Shiki code highlighting, Mermaid diagrams, KaTeX formulas). The link can be visited repeatedly and the content auto-refreshes as the Agent updates it (the same link always points to the latest version).

### 3.2 Manage your own documents ✅

To browse / delete / organize your own document library: visit the site home → log in → **File manager** (dual-pane: tree on the left, list on the right):

- Browse the directory tree, create folders, move (with cycle detection), rename, delete (cascade deletes descendants + disk files + share links);
- Open the owner view page `/d/<id>` for any document;
- Settings → **Share links**: view / revoke shares (once revoked, `/s/<token>` returns 404 immediately);
- Settings → **API Token**: create / revoke.

---

## 4. Configuration reference (environment variables)

| Variable | Default | Description |
|---|---|---|
| `SESSION_SECRET` | (none, required in production) | Session signing key; missing in production triggers fail-fast, missing in dev falls back to an insecure default with a warning |
| `INITIAL_INVITE_CODE` | (none) | Invite code required for registration |
| `DATABASE_PATH` | `./data/app.db` | SQLite path (relative to the runtime cwd) |
| `DATA_DIR` | `./data/documents` | Root directory for documents persisted to disk |
| `BASE_URL` | `http://localhost:5173` | External URL prefix used when generating share links |
| `MAX_UPLOAD_BYTES` | `5242880` (5MB) | Maximum single document size |
| `BODY_SIZE_LIMIT` | adapter-node default 512K | **Bytes (numeric)**, gateway-layer body limit; must be > `MAX_UPLOAD_BYTES` |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `60` / `60000` | Upload rate per token |
| `LOGIN_RATE_LIMIT_MAX` | `10` | Login attempts per email (same window) |
| `SESSION_MAX_AGE` | `2592000` (30 days, seconds) | Session lifetime; exp is embedded in the token and validated server-side |
| `PORT` / `HOST` / `ORIGIN` | `3000` / `0.0.0.0` / — | adapter-node listen address and origin validation |
| `NODE_ENV` | — | Set to `production` to enable secure cookies and require SESSION_SECRET |

> Numeric variables are parsed strictly by `envInt`: non-positive integers throw at module load time (fail-closed) and do not silently degrade.

---

## 5. Troubleshooting

| Symptom | Troubleshooting |
|---|---|
| Production startup reports `SESSION_SECRET must be set in production` | Set `SESSION_SECRET` (a long random string) |
| Production startup reports `Invalid BODY_SIZE_LIMIT` | Use a byte count (e.g. `8388608`) without a unit |
| `better-sqlite3 ... not supported` / `ERR_DLOPEN_FAILED` | You are starting the service with `bun run` — switch to `node apps/web/build/index.js` |
| `bun run test` reports better-sqlite3 load failure | Don't use `bun test`; tests run under vitest via `bun run test` (through node) |
| Upload >512K returns 413 but you are certain it's < `MAX_UPLOAD_BYTES` | `BODY_SIZE_LIMIT` is smaller than the content size (adapter-node defaults to just 512K) |
| Invite code invalid at registration | Verify `INITIAL_INVITE_CODE` matches what was used at startup |
| seed-token reports `Cannot find package 'better-sqlite3'` | Run it from the **repo root** (not apps/web) |
| Docker container `unhealthy` | `docker compose logs web`; commonly a missing port/config/env |
| Link won't open / 404 | Share token revoked or document deleted; have the Agent re-upload |
| Port 5173 taken | dev automatically falls back to 5174; or change `--port` |

---

## 6. Security notes

- **API tokens are upload credentials**. The plaintext is shown only once at generation — keep it safe; if you suspect a leak, revoke immediately (one-click in the UI or manually) and regenerate.
- **Share links are public keys**: anyone with `/s/<token>` can read that document. Don't post them on public channels; the owner can revoke from the "Share links" page.
- **HTTPS is required in production** (the `secure` flag on session cookies depends on it).
- `data/` contains the database and documents — **never commit it** (already gitignored); back up and protect it as confidential material.
- Uploaded `name` / `path` already go through path-safety filtering, but Agents are still encouraged to send well-formed POSIX paths to avoid needless 400s.

---

## Related docs

- [Installation](./INSTALL.en.md) — Docker / manual deployment / reverse proxy / backup & upgrade / configuration reference
- [Product Overview](./PRODUCT.en.md) — positioning, scenarios, features, roadmap
- [Design document](./superpowers/specs/2026-07-18-remote-reader-design.md) — architecture, data model, security model, implementation status
- Quick start: repo root [`README.en.md`](../README.en.md)
