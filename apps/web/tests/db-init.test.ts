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

// A-2：schema.ts ↔ ensureSchema 等价性守卫——生产全新部署建表 100% 走 ensureSchema（SCHEMA_SQL），
// drizzle migration 只服务 dev；漏改任一处会出现“dev 全绿、新部署缺列即崩”。此处遍历 schema.ts
// 全表全列断言在空白库上 ensureSchema 后全部可见，索引（含唯一）同理
test('A-2 schema.ts 全表全列在 ensureSchema 空白库上可见（三处同步守卫）', () => {
    const D = (sqlite as unknown as { constructor: new (path: string) => typeof sqlite }).constructor;
    const tmp = `./data/test-schemawait-${Date.now().toString(36)}.db`;
    const fresh = new D(tmp);
    fresh.pragma('foreign_keys = ON');
    ensureSchema(fresh);

    const expected: Record<string, string[]> = {
        users: ['id', 'email', 'password_hash', 'role', 'created_at'],
        api_tokens: ['id', 'user_id', 'name', 'token_hash', 'last_used_at', 'created_at'],
        invite_codes: ['id', 'code_hash', 'created_by', 'note', 'expires_at', 'revoked_at', 'used_count', 'last_used_at', 'created_at'],
        documents: ['id', 'owner_id', 'parent_id', 'name', 'type', 'storage_path', 'content_hash', 'size_bytes',
            'created_at', 'updated_at', 'storage_tier', 'last_viewed_at', 'archived_at', 'owner_viewed_at', 'storage_backend'],
        share_links: ['id', 'document_id', 'token', 'expires_at', 'created_at'],
        tags: ['id', 'owner_id', 'name', 'created_at'],
        document_tags: ['tag_id', 'document_id']
    };
    for (const [table, cols] of Object.entries(expected)) {
        const got = (fresh.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name);
        expect(got.sort(), `表 ${table} 列不一致：ensureSchema=${got.join(',')}`).toEqual([...cols].sort());
    }

    const expectedIndexes = [
        'users_email_unique',
        'api_tokens_user_id_idx', 'api_tokens_token_hash_idx',
        'invite_codes_code_hash_idx',
        'documents_owner_parent_idx', 'documents_owner_parent_name_type_idx',
        'documents_owner_parent_name_type_uniq',
        'documents_owner_type_updated_idx', 'documents_owner_type_viewed_idx',
        'share_links_token_unique', 'share_links_document_id_idx',
        'tags_owner_name_unique', 'tags_owner_id_idx',
        'document_tags_document_id_idx', 'document_tags_tag_id_idx',
        'images_owner_hash_uniq', 'images_owner_name_uniq', 'images_status_created_idx', 'images_status_ready_idx',
        'image_refs_image_id_idx'
    ];
    const gotIdx = (fresh.prepare(
        "SELECT name FROM sqlite_master WHERE type='index' AND name NOT LIKE 'sqlite_%' AND tbl_name IN ('users','api_tokens','invite_codes','documents','share_links','tags','document_tags','images','image_refs')"
    ).all() as { name: string }[]).map((r) => r.name);
    expect(gotIdx.sort(), `索引不一致：ensureSchema=${gotIdx.join(',')}`).toEqual([...expectedIndexes].sort());
    expect(!!fresh.prepare("SELECT name FROM sqlite_master WHERE name='docs_fts'").get()).toBe(true);

    fresh.close();
    try { rmSync(tmp, { force: true }); try { rmSync(tmp + '-wal', { force: true }); rmSync(tmp + '-shm', { force: true }); } catch {} } catch {}
});
