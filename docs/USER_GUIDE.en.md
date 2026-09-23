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
# Returns {"id":"...","url":"http://localhost:3000/s/<token>"} (plus "warnings": ["..."] if
# unuploaded local image refs are detected; header X-Remote-Reader-Min-Bridge carries the
# recommended minimum bridge version)

# 4) Open the returned url — login-free, rendered immediately (heading, bold, code highlighting)
```

---

## 1. Deployer / Administrator

For full deployment (Docker / manual node / reverse proxy / HTTPS / backup / upgrade migration), see [Installation](./INSTALL.en.md). This section focuses on day-to-day admin operations.

### 1.1 Register first admin

After startup, visit `/register` and register with `INITIAL_INVITE_CODE` — **the first registered user automatically becomes `admin`**. Subsequently registered users become `member`.

Once the first admin exists, DB invite codes can be generated at `/settings/invites` (admin-only) to invite others: choose a validity window (1/7/30 days) at creation, reusable within validity, revocable anytime; the plaintext is shown exactly once. `INITIAL_INVITE_CODE` is a long-lived bootstrap code — rotate it after the initial batch of users, or switch to DB invite codes.

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

### 2.0 Agent self-service onboarding (zero manual steps, recommended)

Send this to your agent (replace the invite code):

> Please visit https://your-host — the "Agent onboarding guide" in the page will walk you through installing the MCP bridge and registering; use invite code ri_xxx, and agree on email/password with me.

The agent reads the `<details id="agent-guide">` block from the login page's SSR HTML (collapsed for humans by default, always visible to agents) and automatically:

1. Installs the bridge: `npx -y remote-reader-bridge` / `bunx remote-reader-bridge` (npm package, recommended — node ≥18, no clone) or `git clone <BRIDGE_REPO_URL> && bun install` (from source)
2. `POST /api/v1/auth/register` (invite code + email + password; existing accounts use `POST /api/v1/auth/login`) → sets the session cookie
3. `POST /api/v1/auth/api-token` (with session cookie) → returns a one-time `rr_` token
4. Writes `~/.config/remote-reader/config.json` → registers the MCP server (`claude mcp add remote-reader -- npx -y remote-reader-bridge` for the npm route, no absolute path needed)

Error shape is uniformly `{"message":"..."}`: 403 invalid invite / 409 email already registered / 429 rate limited / 401 session expired.

### 2.1 Recommended: Local MCP bridge ✅

The bridge (`apps/mcp-bridge`) is a stdio MCP server that exposes the `upload_document` tool, holds the token locally, and forwards requests to the Web API. Agents need not write HTTP by hand.

**Install (choose one)**:

- **npm package (recommended)**: `npx -y remote-reader-bridge` / `bunx remote-reader-bridge` (node ≥18, no bun or clone required). After writing the config file, registration is one line: `claude mcp add remote-reader -- npx -y remote-reader-bridge`
- **From source**: `git clone` this repo + `bun install`; the bridge has no native dependencies and runs directly. **When registering the source entry with an MCP client, always use an absolute path** — the working directory a client spawns the stdio process from is not guaranteed, and a relative path fails intermittently with `Module not found` (typical symptom: the tool works but the status page shows failed).

Two configuration options (env takes precedence over file):

**Option 1: Environment variables** (recommended, passed in one shot by the MCP client)

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

**Other MCP clients** (Cursor / Cline / Windsurf / opencode / ZCode and any client that reads a config file directly): use the standard `mcpServers` JSON with an absolute entry path (ZCode nests the same fields under `mcp.servers` in `~/.zcode/cli/config.json`):

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

If configuration is missing (neither env nor file), the bridge exits at startup (exit 1) and prints guidance. Once configured, the Agent calls `upload_document({ name, content, path? })` and receives a tool result like `Uploaded (id=...). View link: https://.../s/<token>`.

> Debugging: `npx @modelcontextprotocol/inspector bun apps/mcp-bridge/src/index.ts`, or `bun apps/mcp-bridge/scripts/smoke-client.ts <url> <token>` (requires the Web app to be running).

### 2.2 Documents with images: local images auto-uploaded ✅

**Local image references** in `content` are auto-uploaded and rewritten; the Agent needs no extra parameters:

```markdown
# Weekly report
![Architecture](./assets/arch.png)   ← relative paths resolved against the bridge working directory, auto-uploaded
![Remote](https://cdn.example.com/x.png) ← remote URLs are left untouched
```

**Rules and limits**:

- **Path resolution**: relative paths in `![alt](path)` are resolved against the bridge process working directory (Windows drive-letter absolute paths included); remote URLs (`http(s)://`), `data:` URIs, and multi-segment paths containing `/` `\` are **not** treated as local images and are preserved as-is.
- **Formats**: png / jpeg / gif / webp (magic-number detection; the extension must match the real format — a JPEG named `.png` is rejected). **SVG is not supported** (can carry scripts; security decision) — export as png/webp instead.
- **Size**: ≤ `MAX_IMAGE_BYTES` per image (default 10MB; double-checked at init preflight and by relay byte measurement); ≤50 images per document recommended (server rate-limit constraint).
- **Dedup and reclamation**: images are content-addressed by sha256 — identical bytes are stored once per library (re-uploads reuse directly); an image no longer referenced by any document is reclaimed automatically (after an overwrite drops the reference / the document is deleted). No manual cleanup needed.
- **Preflight**: all problems (missing files / unsupported formats / oversize) are listed up front in one pass, never mid-upload.

Via the MCP bridge all of the above is automatic; when calling the HTTP API directly you orchestrate the three endpoints yourself:

| Endpoint | Purpose | Return |
|---|---|---|
| `POST /api/v1/images/init` | Register/query by `{name, content_hash, content_md5, size_bytes}` | `{status:"relay"\|"exists"\|"direct", name, imageId?}` |
| `POST /api/v1/images` | Relay bytes `{image_id, content_base64}` (hash-bound check) | `{name}` |
| `POST /api/v1/images/confirm` | Confirm after s3 direct upload `{image_id}` (ETag/magic check) | `{status:"ok", name}` |

When uploading the md, reference images by their **registered name** in `content` (e.g. `![Screenshot](shot.png)`); the server records the reference set (refs) — only referenced images are visible to the view page (refs whitelist prevents share tokens from enumerating the owner's other images).

### 2.3 Alternative: Direct HTTP API ✅

If you don't use the bridge, you can call the upload API directly:

```
POST /api/v1/documents
Header: Authorization: Bearer <API_TOKEN>
        Content-Type: application/json
Body:   { "name": "<filename>", "content": "<markdown body>", "path": "<optional directory path>" }

Response 200: { "id": "...", "url": "https://<host>/s/<share-token>" }
```

Conditional field `warnings?: string[]`: present when local image references were not uploaded along with the document (usually an outdated bridge); the agent should upgrade the bridge and re-upload. Every successful response carries the `X-Remote-Reader-Min-Bridge` header with the recommended minimum bridge version.

**Parameters**:

- `name` (required): filename, e.g. `weekly.md`. Passed through path-safety filtering (rejects `..` / absolute paths / `\` / `:`, etc.).
- `content` (required): markdown body (UTF-8 string).
- `path` (optional): POSIX-style directory prefix, e.g. `reports/2026-07`. Filtered the same way.

### 2.4 Idempotent semantics (important)

Documents are located by `(owner, path, name)`, and the sha256 of `content` decides the action:

| Case | Behavior | Return value |
|---|---|---|
| No document at that location | Create + persist to disk + generate share link | `{ id, url }` (new) |
| Exists, identical content | **Does not write to disk, does not update timestamp** | `{ id, url }` (same) |
| Exists, different content | Overwrite on disk + update hash/size | `{ id, url }` (**id and url unchanged**) |

> All three cases return `{ id, url }`; `warnings?: string[]` is a conditional field (present when unuploaded local image references are detected, see §2.3).

→ **The view link for the same document remains stable over time**; when the content updates, the link stays the same and points to the latest version automatically. Agents can safely re-upload.

### 2.5 Error codes

| HTTP | Meaning | Handling |
|---|---|---|
| 200 | Upload succeeded | Send the `url` to the user |
| 400 | Invalid request body / JSON parse failure / `name` or `path` contains illegal characters (including `..` traversal) | Fix parameters and retry; do **not** retry as a server fault |
| 401 | Missing token, or token invalid/revoked | Check `Authorization: Bearer` |
| 413 | Content exceeds `MAX_UPLOAD_BYTES` (default 5MB) / image exceeds `MAX_IMAGE_BYTES` (default 10MB) | Split or trim the document |
| 429 | Rate limit triggered (document upload default 60/min per token; image relay has an independent same-size bucket; init/confirm light bucket default 120/min) | Retry with backoff |

---

## 3. Reader

### 3.1 View shared document ✅

When you receive a link from an Agent (e.g. `https://<host>/s/<token>`), **just click it** — no registration or login required, you'll see the rendered document immediately (headings, bold, lists, GFM tables, Shiki code highlighting, Mermaid diagrams, KaTeX formulas). The link can be visited repeatedly and the content auto-refreshes as the Agent updates it (the same link always points to the latest version).

Images inside the document render inline (login-free). **Click any image** to open the Lightbox gallery viewer: wheel/pinch zoom (0.2–10x), pan by dragging when zoomed in, double-click to quickly zoom in/reset, `←`/`→` to move across the gallery, `⛶` fullscreen, `Esc` or `✕` to close.

### 3.2 Manage your own documents ✅

To browse / delete / organize your own document library: visit the site home → log in → **File manager** (dual-pane: tree on the left, list on the right):

- Browse the directory tree, create folders, move (with cycle detection), rename, delete (cascade deletes descendants + disk files + share links);
- Row-start icons distinguish **private / shared** (shared = an active share link exists); the ⋯ menu at row end (desktop dropdown / mobile bottom sheet) hosts all row actions, including **Copy share link** (on a private doc this creates a link and flips it to shared) and **Make private** (revokes every link of that doc at once, irreversible after confirm);
- Open the owner view page `/d/<id>` for any document;
- Settings → **Share links**: view / revoke shares (once revoked, `/s/<token>` returns 404 immediately);
- Settings → **API Token**: create / revoke.

---

## 4. Configuration reference (environment variables)

| Variable | Default | Description |
|---|---|---|
| `SESSION_SECRET` | (none, required in production) | Session signing key; missing in production triggers fail-fast, missing in dev falls back to an insecure default with a warning |
| `INITIAL_INVITE_CODE` | (none) | Bootstrap invite code: required to register the first admin, valid long-term; afterwards use DB invite codes from `/settings/invites` |
| `DATABASE_PATH` | `./data/app.db` | SQLite path (relative to the runtime cwd) |
| `DATA_DIR` | `./data/documents` | Root directory for documents persisted to disk |
| `BASE_URL` | `http://localhost:5173` | External URL prefix used when generating share links |
| `BRIDGE_REPO_URL` | `https://github.com/earneet/remote-reader` | Bridge source repo URL shown in the login-page agent guide (change for custom forks) |
| `MAX_UPLOAD_BYTES` | `5242880` (5MB) | Maximum single document size |
| `BODY_SIZE_LIMIT` | adapter-node default 512K | **Bytes (numeric)**, gateway-layer body limit; production must be ≥ `max(MAX_UPLOAD_BYTES×1.5, MAX_IMAGE_BYTES×1.37×1.5)` (with defaults ≥ 21548237, e.g. `25165824`) |
| `RATE_LIMIT_MAX` / `RATE_LIMIT_WINDOW_MS` | `60` / `60000` | Upload rate per token |
| `LOGIN_RATE_LIMIT_MAX` | `10` | Login attempts per email (same window) |
| `SESSION_MAX_AGE` | `2592000` (30 days, seconds) | Session lifetime; exp is embedded in the token and validated server-side |
| `PORT` / `HOST` / `ORIGIN` | `3000` / `0.0.0.0` / — | adapter-node listen address and origin validation |
| `NODE_ENV` | — | Set to `production` to enable secure cookies and require SESSION_SECRET |
| `OBJECT_STORE_*` (5 vars) | — (all empty = off) | S3-compatible object store (Qiniu/R2/OSS gateway/MinIO) for cold/hot tiering; all-or-nothing — partial config fails startup |
| `COLD_TIER_AFTER_DAYS` | `30` | Cold threshold in days; cold docs rewarm on open and stay viewable & title-searchable |

> Numeric variables are parsed strictly by `envInt`: non-positive integers throw at module load time (fail-closed) and do not silently degrade.

---

## 5. Troubleshooting

| Symptom | Troubleshooting |
|---|---|
| Production startup reports `SESSION_SECRET must be set in production` | Set `SESSION_SECRET` (a long random string) |
| Production startup reports BODY_SIZE_LIMIT must be ≥ max(...) | Raise it to a compliant byte count (e.g. `25165824` with defaults); on systemd deployments `sudo ./scripts/update.sh` migrates it automatically |
| `better-sqlite3 ... not supported` / `ERR_DLOPEN_FAILED` | You are starting the service with `bun run` — switch to `node apps/web/build/index.js` |
| `bun run test` reports better-sqlite3 load failure | Don't use `bun test`; tests run under vitest via `bun run test` (through node) |
| Upload >512K returns 413 but you are certain it's < `MAX_UPLOAD_BYTES` | `BODY_SIZE_LIMIT` is smaller than the content size (adapter-node defaults to just 512K) |
| Invite code invalid at registration | Bootstrap code: verify `INITIAL_INVITE_CODE` matches what was used at startup; DB code: may have expired or been revoked (check `/settings/invites`) |
| seed-token reports `Cannot find package 'better-sqlite3'` | Run it from the **repo root** (not apps/web) |
| Docker container `unhealthy` | `docker compose logs web`; commonly a missing port/config/env |
| Link won't open / 404 | Share token revoked or document deleted; have the Agent re-upload |
| Port 5173 taken | dev automatically falls back to 5174; or change `--port` |

---

## 6. Security notes

- **API tokens are upload credentials**. The plaintext is shown only once at generation — keep it safe; if you suspect a leak, revoke immediately (one-click in the UI or manually) and regenerate.
- **Share links are public keys**: anyone with `/s/<token>` can read that document. Don't post them on public channels; the owner can revoke them all at once via "Make private" in the file manager row menu, or one by one from the "Share links" page.
- **HTTPS is required in production** (the `secure` flag on session cookies depends on it).
- `data/` contains the database and documents — **never commit it** (already gitignored); back up and protect it as confidential material.
- Uploaded `name` / `path` already go through path-safety filtering, but Agents are still encouraged to send well-formed POSIX paths to avoid needless 400s.

---

## Related docs

- [Installation](./INSTALL.en.md) — Docker / manual deployment / reverse proxy / backup & upgrade / configuration reference
- [Product Overview](./PRODUCT.en.md) — positioning, scenarios, features, roadmap
- [Design document](./superpowers/specs/2026-07-18-remote-reader-design.md) — architecture, data model, security model, implementation status
- Quick start: repo root [`README.en.md`](../README.en.md)
