import Database, { type Database as SqliteDb } from 'better-sqlite3';
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
CREATE TABLE IF NOT EXISTS invite_codes (
    id text PRIMARY KEY NOT NULL,
    code_hash text NOT NULL,
    created_by text NOT NULL,
    note text NOT NULL,
    expires_at integer NOT NULL,
    revoked_at integer,
    used_count integer NOT NULL,
    last_used_at integer,
    created_at integer NOT NULL,
    FOREIGN KEY (created_by) REFERENCES users(id) ON UPDATE no action ON DELETE no action
);
CREATE INDEX IF NOT EXISTS invite_codes_code_hash_idx ON invite_codes (code_hash);
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
    storage_tier text NOT NULL DEFAULT 'hot',
    last_viewed_at integer,
    archived_at integer,
    owner_viewed_at integer,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON UPDATE no action ON DELETE no action
);
CREATE INDEX IF NOT EXISTS documents_owner_parent_idx ON documents (owner_id, parent_id);
CREATE INDEX IF NOT EXISTS documents_owner_parent_name_type_idx ON documents (owner_id, parent_id, name, type);
CREATE INDEX IF NOT EXISTS documents_owner_type_updated_idx ON documents (owner_id, type, updated_at DESC, id DESC);
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
CREATE TABLE IF NOT EXISTS tags (
    id text PRIMARY KEY NOT NULL,
    owner_id text NOT NULL,
    name text NOT NULL,
    created_at integer NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON UPDATE no action ON DELETE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_owner_name_unique ON tags (owner_id, name);
CREATE INDEX IF NOT EXISTS tags_owner_id_idx ON tags (owner_id);
CREATE TABLE IF NOT EXISTS document_tags (
    tag_id text NOT NULL,
    document_id text NOT NULL,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON UPDATE no action ON DELETE cascade,
    PRIMARY KEY (tag_id, document_id)
);
CREATE INDEX IF NOT EXISTS document_tags_document_id_idx ON document_tags (document_id);
CREATE INDEX IF NOT EXISTS document_tags_tag_id_idx ON document_tags (tag_id);
CREATE TABLE IF NOT EXISTS images (
    id text PRIMARY KEY NOT NULL,
    owner_id text NOT NULL,
    name text NOT NULL,
    content_hash text NOT NULL,
    content_md5 text NOT NULL,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    storage_backend text NOT NULL,
    storage_key text NOT NULL,
    created_at integer NOT NULL,
    ready_at integer,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON UPDATE no action ON DELETE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS images_owner_hash_uniq ON images (owner_id, content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS images_owner_name_uniq ON images (owner_id, name);
CREATE INDEX IF NOT EXISTS images_status_created_idx ON images (status, created_at);
CREATE INDEX IF NOT EXISTS images_status_ready_idx ON images (status, ready_at);
CREATE TABLE IF NOT EXISTS image_refs (
    document_id text NOT NULL,
    image_id text NOT NULL,
    created_at integer NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (image_id) REFERENCES images(id) ON UPDATE no action ON DELETE no action,
    PRIMARY KEY (document_id, image_id)
);
CREATE INDEX IF NOT EXISTS image_refs_image_id_idx ON image_refs (image_id);
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(doc_id UNINDEXED, name, content, tokenize = 'trigram');
`;

const dbPath = process.env.DATABASE_PATH ?? './data/app.db';
const dir = dirname(dbPath);
if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

export const sqlite = new Database(dbPath);
sqlite.pragma('journal_mode = WAL');
sqlite.pragma('synchronous = NORMAL');
sqlite.pragma('temp_store = MEMORY');
sqlite.pragma('foreign_keys = ON');
sqlite.pragma('busy_timeout = 5000');

// C1: 启动时 idempotent 建表 + 索引，全新部署（含 Docker 容器）无需手动 migrate 即可工作，
// 避免首请求 500 (no such table)。dev 的 drizzle-kit migrate 仍可用；IF NOT EXISTS 保证两者共存不冲突。
// 改 schema 时须同步 schema.ts 声明与 drizzle migration，保持三处一致。

// 冷热分层三列：存量库升级（CREATE TABLE IF NOT EXISTS 对已存在的表是 no-op）
export function ensureTierColumns(target: SqliteDb): void {
    const cols = target.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('storage_tier')) {
        target.exec("ALTER TABLE documents ADD COLUMN storage_tier text NOT NULL DEFAULT 'hot'");
    }
    if (!names.has('last_viewed_at')) {
        target.exec('ALTER TABLE documents ADD COLUMN last_viewed_at integer');
    }
    if (!names.has('archived_at')) {
        target.exec('ALTER TABLE documents ADD COLUMN archived_at integer');
    }
}

// 「最近浏览」列（spec §5.2）：索引创建收敛在列补齐之后——若索引进 SCHEMA_SQL，
// 存量库（表已存在、CREATE TABLE 为 no-op）会在 prepare 阶段因列不存在抛错，启动即崩
export function ensureOwnerViewedColumn(target: SqliteDb): void {
    const cols = target.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('owner_viewed_at')) {
        target.exec('ALTER TABLE documents ADD COLUMN owner_viewed_at integer');
    }
    target.exec('CREATE INDEX IF NOT EXISTS documents_owner_type_viewed_idx ON documents (owner_id, type, owner_viewed_at DESC, id DESC)');
}

// 图片支持（spec §4.1）：documents 冷档溯源列——存量库 ALTER 兜底 + 存量 cold 行一次性回填 's3'
// （现状唯一归档后端；幂等：WHERE storage_backend IS NULL 使回填只补不覆盖）
export function ensureDocumentsStorageBackendColumn(target: SqliteDb): void {
    const cols = target.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'storage_backend')) {
        target.exec('ALTER TABLE documents ADD COLUMN storage_backend text');
    }
    target.exec("UPDATE documents SET storage_backend = 's3' WHERE storage_tier = 'cold' AND storage_backend IS NULL");
}

// P1-1 唯一索引前的存量清洗：清除并发首传竞态产生的同 (owner, parent, name, type) 重复行
// （保留 rowid 最小者 = findNode().get() 实际命中的行；share_links/docs_fts 无级联须先清，
// document_tags 有 ON DELETE cascade 随行删除）。仅在索引尚不存在时执行一次
function dedupeDuplicateNames(target: SqliteDb): void {
    const DUP_IDS = `
        SELECT d.id FROM documents d JOIN (
            SELECT owner_id, IFNULL(parent_id, '') AS pid, name, type, MIN(rowid) AS keep_rowid
            FROM documents GROUP BY owner_id, IFNULL(parent_id, ''), name, type HAVING COUNT(*) > 1
        ) g ON d.owner_id = g.owner_id AND IFNULL(d.parent_id, '') = g.pid
          AND d.name = g.name AND d.type = g.type AND d.rowid > g.keep_rowid`;
    target.exec(`
        DELETE FROM share_links WHERE document_id IN (${DUP_IDS});
        DELETE FROM docs_fts WHERE doc_id IN (${DUP_IDS});
        DELETE FROM documents WHERE id IN (${DUP_IDS});
    `);
}

export function ensureSchema(target: SqliteDb = sqlite): void {
    target.exec(SCHEMA_SQL);
    ensureTierColumns(target);
    ensureOwnerViewedColumn(target);
    ensureDocumentsStorageBackendColumn(target);
    // P1-1 唯一索引不进 SCHEMA_SQL：存量库可能带竞态重复行，CREATE UNIQUE 会启动即崩——先清洗再建
    const hasUnique = target.prepare(
        "SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'documents_owner_parent_name_type_uniq'"
    ).get();
    if (!hasUnique) dedupeDuplicateNames(target);
    target.exec(`CREATE UNIQUE INDEX IF NOT EXISTS documents_owner_parent_name_type_uniq
        ON documents (owner_id, COALESCE(parent_id, ''), name, type)`);
}
ensureSchema();
void import('../fts').then((m) => m.backfillFts()).catch((e) => console.warn('[backfillFts] failed', e));

export const db = drizzle(sqlite, { schema });
export { schema };
