import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import * as schema from './schema';

const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
    id text PRIMARY KEY NOT NULL,
    email text NOT NULL,
    password_hash text NOT NULL,
    role text NOT NULL,
    created_at integer NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_unique ON users (email);
CREATE TABLE IF NOT EXISTS api_tokens (
    id text PRIMARY KEY NOT NULL,
    user_id text NOT NULL,
    name text NOT NULL,
    token_hash text NOT NULL,
    last_used_at integer,
    created_at integer NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON UPDATE no action ON DELETE no action
);
CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx ON api_tokens (user_id);
CREATE INDEX IF NOT EXISTS api_tokens_token_hash_idx ON api_tokens (token_hash);
CREATE TABLE IF NOT EXISTS documents (
    id text PRIMARY KEY NOT NULL,
    owner_id text NOT NULL,
    parent_id text,
    name text NOT NULL,
    type text NOT NULL,
    storage_path text,
    content_hash text,
    size_bytes integer,
    created_at integer NOT NULL,
    updated_at integer NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON UPDATE no action ON DELETE no action
);
CREATE INDEX IF NOT EXISTS documents_owner_parent_idx ON documents (owner_id, parent_id);
CREATE INDEX IF NOT EXISTS documents_owner_parent_name_type_idx ON documents (owner_id, parent_id, name, type);
CREATE TABLE IF NOT EXISTS share_links (
    id text PRIMARY KEY NOT NULL,
    document_id text NOT NULL,
    token text NOT NULL,
    expires_at integer,
    created_at integer NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON UPDATE no action ON DELETE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS share_links_token_unique ON share_links (token);
CREATE INDEX IF NOT EXISTS share_links_document_id_idx ON share_links (document_id);
`;

const dbPath = process.env.DATABASE_PATH ?? './data/app.db';
const dir = dirname(dbPath);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

export const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('temp_store = MEMORY');
sqlite.pragma('foreign_keys = ON');

// C1: 启动时 idempotent 建表 + 索引，全新部署（含 Docker 容器）无需手动 migrate 即可工作，
// 避免首请求 500 (no such table)。dev 的 drizzle-kit migrate 仍可用；IF NOT EXISTS 保证两者共存不冲突。
// 改 schema 时须同步 schema.ts 声明与 drizzle migration，保持三处一致。
export function ensureSchema(): void {
    sqlite.exec(SCHEMA_SQL);
}
ensureSchema();

export const db = drizzle(sqlite, { schema });
export { schema };
