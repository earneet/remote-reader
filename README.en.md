# Remote Reader

> English | [中文](./README.md)

Lets remote-working AI agents **deliver** finished Markdown documents to humans in one step: the agent uploads via MCP → gets a login-free view link → sends it over IM → the user clicks and instantly sees a fully rendered page with syntax highlighting, tables, flowcharts, and formulas.

Remote Reader is the "document delivery window" for agents — MCP on the write side, browser on the read side, all in one shot. Built to solve the problems of long documents flooding chat, incomplete Markdown rendering, and being unable to find things afterwards.

## ✨ Features

- **Native MCP upload** —— The agent uploads by calling a single `upload_document` tool; the local bridge holds the API token and never exposes it to the agent
- **Login-free one-step viewing** —— `/s/<token>` renders on click; readers need no account or sign-in
- **Complete Markdown rendering** —— GFM tables, [Shiki](https://shiki.style) code highlighting (~15 languages), Mermaid flowcharts, KaTeX math (lazy-loaded on demand; zero downloads for plain text)
- **Idempotent uploads** —— Same path + same content never duplicates; on content update the **link stays the same** and auto-points to the latest version
- **Management UI** —— File manager (directory tree / move / rename / delete), API token management (create / revoke / one-time reveal), share link revocation
- **Multi-user isolation** —— Documents live in per-owner directory trees; SQLite foreign-key constraints enforce integrity
- **Secure by default** —— argon2id password hashing, HMAC sessions + constant-time comparison + expiry check, path-traversal protection, `html:false` for XSS defense, API tokens stored only as sha256 hashes
- **Production-ready** —— Multi-stage Docker image, non-root runtime, HEALTHCHECK, one-command Docker Compose deployment

## Architecture

```mermaid
sequenceDiagram
    participant Agent
    participant Bridge as Local MCP bridge
    participant Web as Web app
    participant User as Human user

    Agent->>Bridge: upload_document(name, content, path)
    Bridge->>Web: POST /api/v1/documents (Bearer Token)
    Web->>Web: persist to disk + write DB + generate share token
    Web-->>Bridge: { id, url }
    Bridge-->>Agent: Uploaded, view link: /s/<token>
    Agent->>User: IM: "Doc is ready 👉 https://host/s/<token>"
    User->>Web: Click link (login-free)
    Web-->>User: SSR-rendered Markdown
```

Three components:

- **Web app** (`apps/web`, full-stack SvelteKit) —— storage + Markdown rendering + HTTP API + auth, deployed on the remote server
- **Local MCP bridge** (`apps/mcp-bridge`) —— deployed on the user's machine, forwards the agent's MCP tool calls (stdio) into HTTP requests against the Web API; holds the token
- **Shared layer** (`packages/shared`) —— MCP tool definitions, API client, types, shared by web and bridge

## Quick Start

### Option 1: Docker (recommended for production)

```bash
cp .env.example .env            # At minimum, change SESSION_SECRET and INITIAL_INVITE_CODE
docker compose up -d --build    # → http://localhost:3000
```

### Option 2: Local development

```bash
bun install
bun --filter remote-reader-web db:migrate   # Generates data/app.db
bun --filter remote-reader-web dev          # http://localhost:5173 (falls back to 5174 if taken)
```

Then:

1. Visit `/register` and register with `INITIAL_INVITE_CODE` (the first user automatically becomes admin)
2. Generate an API token: `node scripts/seed-token.mjs <your-email>` (the plaintext is shown only once — save it immediately)
3. Upload a document:

   ```bash
   curl -X POST http://localhost:5173/api/v1/documents \
     -H "Authorization: Bearer <TOKEN>" -H "Content-Type: application/json" \
     -d '{"name":"hello.md","content":"# Hello","path":"demo"}'
   ```

4. Open the returned `url` (of the form `/s/<token>`) —— view the rendered result with no login

For full deployment (reverse proxy, HTTPS, backup, upgrade migrations), see [Installation](./docs/INSTALL.en.md).

## Upload via MCP (Agent)

The local MCP bridge lets an agent upload via an MCP tool call; the bridge holds the token locally and never exposes it to the agent. Once configured, the agent just calls `upload_document({ name, content, path? })` to get the view link.

```bash
# Claude Code integration (pass url + token via env)
claude mcp add remote-reader bun apps/mcp-bridge/src/index.ts \
  -e REMOTE_READER_URL=http://localhost:5173 \
  -e REMOTE_READER_TOKEN=rr_xxx
```

Alternatively, write `{ baseUrl, token }` into `~/.config/remote-reader/config.json` and register only the command (env takes precedence over the file; if config is missing, the bridge exits on startup). See [User Guide](./docs/USER_GUIDE.en.md).

## Idempotent upload semantics

Documents are located by `(owner, path, name)`; the sha256 of the content decides:

| Case | Behavior | Return |
|---|---|---|
| No document at this location | Create + persist to disk + generate share link | `{ id, url }` (new) |
| Exists, same content | **No disk write, no timestamp change** | `{ id, url }` (same) |
| Exists, different content | Overwrite on disk + update hash/size | `{ id, url }` (**id and url unchanged**) |

→ The view link for a given document stays stable long-term; after a content update the link is unchanged and auto-points to the latest version. Agents can safely re-upload.

## Tech Stack

TypeScript · Bun (package manager + dev/build host) · SvelteKit (full-stack SSR) · Drizzle ORM + SQLite (better-sqlite3) · markdown-it + Shiki · Mermaid + KaTeX · @node-rs/argon2 · vitest

> ⚠️ **Runtime split**: `better-sqlite3` is a native addon that **fails to load under bun's direct runtime** (works only under `bun + vite dev/build`). So: tests use `bun run test` (vitest, runs under node); dev/build/install use bun; **production uses `node apps/web/build/index.js`** (adapter-node output — do not start the server with `bun run`). The Docker image already follows this rule.

## Development

```bash
bun install                                   # Install all workspace dependencies
bun run test                                  # All unit tests (vitest, node runtime)
bun run test apps/web/tests/documents.test.ts # Single file
bun --filter remote-reader-web check          # svelte-check type check
bun --filter remote-reader-web dev            # Dev server
bun --filter remote-reader-web build          # Production build
```

For an end-to-end check: start the dev server in another terminal, then run `TOKEN=$(node scripts/seed-token.mjs <email> | sed 's/^TOKEN=//') API_TOKEN=$TOKEN BASE_URL=http://localhost:5174 ./scripts/e2e-check.sh`.

## Documentation

- [Installation](./docs/INSTALL.en.md) —— Docker / manual deployment / reverse proxy / backup & upgrade / configuration reference
- [User Guide](./docs/USER_GUIDE.en.md) —— Three perspectives: deployer / agent operator / reader
- [Product Overview](./docs/PRODUCT.en.md) —— Positioning, scenarios, features, roadmap
- [Design Document](./docs/superpowers/specs/2026-07-18-remote-reader-design.md) —— Architecture, data model, security model, implementation status

## License

[MIT](./LICENSE)
