import { test, expect } from 'vitest';
import { sqlite, ensureSchema } from '../src/lib/server/db';

test('ensureSchema 建表：四张表均存在', () => {
    const rows = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','api_tokens','documents','share_links')"
    ).all() as { name: string }[];
    expect(rows.map((r) => r.name).sort()).toEqual(['api_tokens', 'documents', 'share_links', 'users']);
});

test('foreign_keys PRAGMA 已开启（FK 约束生效）', () => {
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
});

test('journal_mode = WAL', () => {
    expect(String(sqlite.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
});

test('性能索引已创建（M12）', () => {
    const rows = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('documents_owner_parent_idx','documents_owner_parent_name_type_idx','share_links_document_id_idx','api_tokens_user_id_idx','api_tokens_token_hash_idx')"
    ).all() as { name: string }[];
    expect(rows.map((r) => r.name).sort()).toEqual([
        'api_tokens_token_hash_idx',
        'api_tokens_user_id_idx',
        'documents_owner_parent_idx',
        'documents_owner_parent_name_type_idx',
        'share_links_document_id_idx'
    ]);
});

test('ensureSchema 幂等：重复执行不报错', () => {
    expect(() => ensureSchema()).not.toThrow();
});

test('FK 约束真实生效：插入孤儿 document 被拒', () => {
    expect(() =>
        sqlite.prepare(
            "INSERT INTO documents (id, owner_id, name, type, created_at, updated_at) VALUES ('fk-test','nonexistent-user','x','file',1,1)"
        ).run()
    ).toThrow();
});
