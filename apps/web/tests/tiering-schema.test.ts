import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ensureTierColumns, sqlite } from '../src/lib/server/db';

const OLD_DOCUMENTS_SQL = `CREATE TABLE documents (
    id text PRIMARY KEY NOT NULL,
    owner_id text NOT NULL,
    parent_id text,
    name text NOT NULL,
    type text NOT NULL,
    storage_path text,
    content_hash text,
    size_bytes integer,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
)`;

test('主库 documents 表含分层三列', () => {
    const cols = sqlite.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('storage_tier');
    expect(names).toContain('last_viewed_at');
    expect(names).toContain('archived_at');
});

test('旧库经 ensureTierColumns 升级出三列且幂等，存量行默认 hot', () => {
    const raw = new Database(':memory:');
    raw.exec(OLD_DOCUMENTS_SQL);
    ensureTierColumns(raw);
    ensureTierColumns(raw);
    const cols = raw.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('storage_tier');
    expect(names).toContain('last_viewed_at');
    expect(names).toContain('archived_at');
    raw.exec(`INSERT INTO documents (id, owner_id, name, type, created_at, updated_at)
              VALUES ('d1', 'u1', 'a.md', 'file', 1, 1)`);
    const row = raw.prepare('SELECT storage_tier FROM documents WHERE id = ?').get('d1') as { storage_tier: string };
    expect(row.storage_tier).toBe('hot');
});
