import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { indexDoc, unindexDocs, backfillFts } from '../src/lib/server/fts';

import { resetDb } from './helpers';
let ownerId: string;
const TMP = `./data/test-fts-${Date.now().toString(36)}`;

beforeEach(() => {
    process.env.DATA_DIR = TMP;
    try { mkdirSync(TMP, { recursive: true }); } catch {}
    resetDb();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId, email: `f-${Date.now()}@x.com`, passwordHash: 'x',
        role: 'member', createdAt: Date.now()
    }).run();
});
afterEach(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

test('indexDoc 写入后可被 MATCH 命中（trigram 对连续中文 3 字子串命中）', () => {
    indexDoc('d1', 'weekly.md', '本周项目周报进展');
    const r = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"周项目"') as { doc_id: string }[];
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
    await expect(backfillFts()).resolves.toBeUndefined();
    expect((sqlite.prepare('SELECT doc_id FROM docs_fts WHERE doc_id = ?').all('missing') as { doc_id: string }[]).length).toBe(0);
});

// cycle2 修复项的回归锁：候选查询不看 tier（FTS 被归档清空的 cold 行会进候选、storagePath
// 冷态保留、盘文件可能仍在），灌入前的热态复核是「归档后内容词不可搜」的唯一防线——删掉
// 复核 continue，cold 行内容被重灌泄漏，此用例必红
test('backfillFts 灌入前重验热态：cold 行不灌入（防全文重灌泄漏冷文档内容）', async () => {
    try { mkdirSync(`${TMP}/${ownerId}`, { recursive: true }); } catch {}
    writeFileSync(`${TMP}/${ownerId}/hot.md`, 'hotword secret content');
    writeFileSync(`${TMP}/${ownerId}/cold.md`, 'coldword secret content');
    db.insert(schema.documents).values([
        { id: 'hot1', ownerId, parentId: null, name: 'hot.md', type: 'file',
            storagePath: `${TMP}/${ownerId}/hot.md`, contentHash: 'h1', sizeBytes: 1,
            createdAt: Date.now(), updatedAt: Date.now() },
        // 模拟归档后状态：tier=cold、FTS 已清（resetDb 起点）、盘文件尚未删除的窗口
        { id: 'cold1', ownerId, parentId: null, name: 'cold.md', type: 'file',
            storagePath: `${TMP}/${ownerId}/cold.md`, contentHash: 'h2', sizeBytes: 1,
            createdAt: Date.now(), updatedAt: Date.now(), storageTier: 'cold' }
    ]).run();
    await backfillFts();
    const hotHit = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"hotword"') as { doc_id: string }[];
    expect(hotHit.map((r) => r.doc_id)).toEqual(['hot1']);
    const coldHit = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"coldword"') as { doc_id: string }[];
    expect(coldHit.length).toBe(0);
});
