import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { indexDoc, unindexDocs, backfillFts } from '../src/lib/server/fts';

let ownerId: string;
const TMP = `./data/test-fts-${Date.now().toString(36)}`;

beforeEach(() => {
    process.env.DATA_DIR = TMP;
    try { mkdirSync(TMP, { recursive: true }); } catch {}
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId, email: `f-${Date.now()}@x.com`, passwordHash: 'x',
        role: 'member', createdAt: Date.now()
    }).run();
});
afterEach(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

test('indexDoc 写入后可被 MATCH 命中', () => {
    // unicode61 把连续 CJK 当单 token，故用空格让"周报"成独立 token 才能被短语命中
    indexDoc('d1', 'weekly.md', '本周 周报 进展');
    const r = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"周报"') as { doc_id: string }[];
    expect(r[0].doc_id).toBe('d1');
});

test('unindexDocs 删除后不再命中', () => {
    indexDoc('d1', 'a.md', 'hello world');
    unindexDocs(['d1']);
    const r = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"hello"') as { doc_id: string }[];
    expect(r.length).toBe(0);
});

test('backfillFts 把历史文档灌入索引', async () => {
    const path = `${TMP}/${ownerId}/old.md`;
    try { mkdirSync(`${TMP}/${ownerId}`, { recursive: true }); } catch {}
    writeFileSync(path, 'legacy content searchable');
    db.insert(schema.documents).values({
        id: 'old1', ownerId, parentId: null, name: 'old.md', type: 'file',
        storagePath: path, contentHash: 'h', sizeBytes: 10,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    await backfillFts();
    const r = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"legacy"') as { doc_id: string }[];
    expect(r[0].doc_id).toBe('old1');
});

test('backfillFts 遇缺文件跳过不抛', async () => {
    db.insert(schema.documents).values({
        id: 'missing', ownerId, parentId: null, name: 'gone.md', type: 'file',
        storagePath: '/nonexistent/path/gone.md', contentHash: 'h', sizeBytes: 1,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    await expect(backfillFts()).resolves.not.toThrow();
    expect((sqlite.prepare('SELECT doc_id FROM docs_fts WHERE doc_id = ?').all('missing') as { doc_id: string }[]).length).toBe(0);
});
