import { test, expect } from 'vitest';
import { rmSync } from 'node:fs';
import { sqlite, ensureSchema } from '../src/lib/server/db';

test('ensureSchema 建表：五张表均存在', () => {
    const rows = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','api_tokens','documents','share_links','invite_codes')"
    ).all() as { name: string }[];
    expect(rows.map((r) => r.name).sort()).toEqual(['api_tokens', 'documents', 'invite_codes', 'share_links', 'users']);
});

test('foreign_keys PRAGMA 已开启（FK 约束生效）', () => {
    expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
});

test('journal_mode = WAL', () => {
    expect(String(sqlite.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
});

test('性能索引已创建（M12）', () => {
    const rows = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name IN ('documents_owner_parent_idx','documents_owner_parent_name_type_idx','share_links_document_id_idx','api_tokens_user_id_idx','api_tokens_token_hash_idx','invite_codes_code_hash_idx')"
    ).all() as { name: string }[];
    expect(rows.map((r) => r.name).sort()).toEqual([
        'api_tokens_token_hash_idx',
        'api_tokens_user_id_idx',
        'documents_owner_parent_idx',
        'documents_owner_parent_name_type_idx',
        'invite_codes_code_hash_idx',
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

test('busy_timeout 已设置（防并发写 SQLITE_BUSY 偶发 500）', () => {
    expect(sqlite.pragma('busy_timeout', { simple: true })).toBeGreaterThan(0);
});

test('P1-1 唯一索引存在（并发首传防线）', () => {
    const row = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name='documents_owner_parent_name_type_uniq'"
    ).get();
    expect(row).toBeTruthy();
    expect(() =>
        sqlite.prepare(
            "INSERT INTO documents (id, owner_id, name, type, created_at, updated_at) VALUES ('uq-1','nonexistent','x','file',1,1)"
        ).run()
    ).toThrow(); // FK 先拦（owner 不存在），唯一性由 documents.test 的并发用例覆盖
});

test('P1-1 存量库升级：ensureSchema 清洗竞态重复行后建唯一索引', () => {
    const D = (sqlite as unknown as { constructor: new (path: string) => typeof sqlite }).constructor;
    const tmp = `./data/test-dbinit-${Date.now().toString(36)}.db`;
    const legacy = new D(tmp);
    legacy.pragma('foreign_keys = ON');
    legacy.exec(`
        CREATE TABLE documents (
            id text PRIMARY KEY NOT NULL, owner_id text NOT NULL, parent_id text, name text NOT NULL,
            type text NOT NULL, storage_path text, content_hash text, size_bytes integer,
            created_at integer NOT NULL, updated_at integer NOT NULL
        );
        CREATE TABLE share_links (
            id text PRIMARY KEY NOT NULL, document_id text NOT NULL, token text NOT NULL,
            expires_at integer, created_at integer NOT NULL
        );
    `);
    legacy.exec("INSERT INTO documents VALUES('d1','u1',NULL,'a.md','file','/x/1','h1',1,1,1)");
    legacy.exec("INSERT INTO documents VALUES('d2','u1',NULL,'a.md','file','/x/1','h2',2,2,2)");
    legacy.exec("INSERT INTO share_links VALUES('s1','d1','t1',NULL,1)");
    legacy.exec("INSERT INTO share_links VALUES('s2','d2','t2',NULL,1)");

    expect(() => ensureSchema(legacy)).not.toThrow();
    expect(legacy.prepare('SELECT COUNT(*) c FROM documents').get()).toMatchObject({ c: 1 });
    expect(legacy.prepare('SELECT COUNT(*) c FROM share_links').get()).toMatchObject({ c: 1 });
    expect(legacy.prepare("SELECT 1 FROM sqlite_master WHERE name='documents_owner_parent_name_type_uniq'").get()).toBeTruthy();
    expect(() => legacy.exec("INSERT INTO documents VALUES('d3','u1',NULL,'a.md','file','/x/1','h3',3,3,3)")).toThrow();
    legacy.close();
    try { rmSync(tmp, { force: true }); try { rmSync(tmp + '-wal', { force: true }); rmSync(tmp + '-shm', { force: true }); } catch {} } catch {}
});
