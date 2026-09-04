import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId, sha256Hex } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';
import { isColdCandidate, runArchiveCycle, rewarmDocument, withDocLock } from '../src/lib/server/tiering';
import { MemoryObjectStore, __setObjectStoreForTest, objectKeyFor } from '../src/lib/server/object-store';
import { eq } from 'drizzle-orm';

const DAY = 86_400_000;
let ownerId: string;
let store: MemoryObjectStore;
const TMP_DOCS = `./data/test-tiering-${Date.now().toString(36)}`;

function getDoc(id: string) {
    return db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!;
}

beforeEach(async () => {
    process.env.DATA_DIR = TMP_DOCS;
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId, email: `t-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    store = new MemoryObjectStore();
    __setObjectStoreForTest(store);
});

afterEach(() => {
    try { rmSync(TMP_DOCS, { recursive: true, force: true }); } catch {}
    __setObjectStoreForTest(undefined);
});

// 冷态夹具：上传 → 把 updated_at 回拨 40 天 → 跑一轮归档
async function makeCold(content: string, name = 'd.md'): Promise<string> {
    const r = await uploadDocument(ownerId, name, content, []);
    db.update(schema.documents)
        .set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY })
        .where(eq(schema.documents.id, r.id)).run();
    await runArchiveCycle(store);
    expect(getDoc(r.id).storageTier).toBe('cold');
    return r.id;
}

test('isColdCandidate：file+hot+超阈值；folder/cold/无盘路径/新文档不冷', () => {
    const now = Date.now();
    const base = { type: 'file', storageTier: 'hot', storagePath: '/x', createdAt: now - 40 * DAY, updatedAt: now - 40 * DAY, lastViewedAt: null };
    expect(isColdCandidate(base, now, 30)).toBe(true);
    expect(isColdCandidate({ ...base, updatedAt: now - 29 * DAY }, now, 30)).toBe(false);
    expect(isColdCandidate({ ...base, type: 'folder' }, now, 30)).toBe(false);
    expect(isColdCandidate({ ...base, storageTier: 'cold' }, now, 30)).toBe(false);
    expect(isColdCandidate({ ...base, storagePath: null }, now, 30)).toBe(false);
    // last_viewed_at 晚于 updated_at → 以 last_viewed_at 判定（看过就推迟冷却）
    expect(isColdCandidate({ ...base, lastViewedAt: now - 5 * DAY }, now, 30)).toBe(false);
    // 看过但很久以前 + 从未更新 → 仍冷（last_viewed_at ?? created_at 回退链生效）
    expect(isColdCandidate({ ...base, lastViewedAt: now - 40 * DAY }, now, 30)).toBe(true);
});

test('归档全流程：PUT 对象 → DB 标 cold + FTS 清 content → 删本地', async () => {
    const r = await uploadDocument(ownerId, 'a.md', '# hello archive-me', []);
    const row = getDoc(r.id);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    const n = await runArchiveCycle(store);
    expect(n).toBe(1);
    const after = getDoc(r.id);
    expect(after.storageTier).toBe('cold');
    expect(after.archivedAt).toBeGreaterThan(0);
    expect(existsSync(row.storagePath!)).toBe(false);
    const key = objectKeyFor(after);
    expect(store.data.get(key)).toBe('# hello archive-me');
    const fts = sqlite.prepare('SELECT content FROM docs_fts WHERE doc_id = ?').get(r.id) as { content: string };
    expect(fts.content).toBe('');
    // storage_path 保留（回热落地路径）
    expect(after.storagePath).toBe(row.storagePath);
});

test('hash 不一致（盘内容被篡改）→ 跳过归档，保持 hot', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'v1', []);
    const row = getDoc(r.id);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    const { writeFile } = await import('../src/lib/server/storage');
    await writeFile(row.storagePath!, 'tampered'); // 磁盘内容 ≠ DB hash
    const n = await runArchiveCycle(store);
    expect(n).toBe(0);
    expect(getDoc(r.id).storageTier).toBe('hot');
    expect(store.data.size).toBe(0);
});

test('本地文件缺失 → 跳过归档（不造出"两边皆空"）', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'v1', []);
    const row = getDoc(r.id);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    const { unlink } = await import('node:fs/promises');
    await unlink(row.storagePath!);
    expect(await runArchiveCycle(store)).toBe(0);
    expect(getDoc(r.id).storageTier).toBe('hot');
});

test('崩溃窗口：PUT 失败 → 保持 hot、本地完好、FTS 完整（数据无损）', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'keep me', []);
    const row = getDoc(r.id);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    store.failPut = true;
    expect(await runArchiveCycle(store)).toBe(0); // 单文档失败被 cycle 捕获隔离，计数 0
    store.failPut = false;
    expect(getDoc(r.id).storageTier).toBe('hot');
    expect(existsSync(row.storagePath!)).toBe(true);
});

test('回热：GET → 写本地 → DB 标 hot + FTS 恢复 → 删远端', async () => {
    const id = await makeCold('# rewarm me');
    const row = getDoc(id);
    await rewarmDocument(id, '# rewarm me');
    const after = getDoc(id);
    expect(after.storageTier).toBe('hot');
    expect(after.lastViewedAt).toBeGreaterThan(0);
    expect(after.archivedAt).toBeNull();
    expect(existsSync(after.storagePath!)).toBe(true);
    const { readFile } = await import('../src/lib/server/storage');
    expect(await readFile(after.storagePath!)).toBe('# rewarm me');
    expect(store.data.has(objectKeyFor(row))).toBe(false);
    const fts = sqlite.prepare('SELECT content FROM docs_fts WHERE doc_id = ?').get(id) as { content: string };
    expect(fts.content).toBe('# rewarm me');
});

test('回热崩溃窗口：删远端失败 → hot + 远端孤儿（无害，不丢内容）', async () => {
    const id = await makeCold('# x');
    store.failDelete = true;
    await rewarmDocument(id, '# x');
    expect(getDoc(id).storageTier).toBe('hot');
    expect(store.data.size).toBe(1); // 孤儿对象仍在
    store.failDelete = false;
});

test('withDocLock 串行化同 docId 操作', async () => {
    const order: number[] = [];
    const slow = withDocLock('d', async () => {
        await new Promise((r) => setTimeout(r, 30));
        order.push(1);
    });
    await withDocLock('d', async () => { order.push(2); });
    await slow;
    expect(order).toEqual([1, 2]);
});

test('批量上限 50：60 个候选单轮只归档 50，下一轮清尾', async () => {
    for (let i = 0; i < 60; i++) {
        const r = await uploadDocument(ownerId, `f${i}.md`, `c${i}`, []);
        db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    }
    expect(await runArchiveCycle(store)).toBe(50);
    expect(await runArchiveCycle(store)).toBe(10);
});
// ── 竞态回归（spec §4.2，双 Agent 交叉审查发现，用 gate 注入交错）──
class GatedMemoryStore extends MemoryObjectStore {
    gate: Promise<void> = Promise.resolve();
    async put(key: string, content: string): Promise<void> {
        await this.gate;
        return super.put(key, content);
    }
    async get(key: string): Promise<string> {
        await this.gate;
        return super.get(key);
    }
}

test('竞态：归档 PUT 窗口内覆盖上传 → doc 锁串行化，v2 完好不丢（P0 回归）', async () => {
    const gated = new GatedMemoryStore();
    __setObjectStoreForTest(gated);
    const r = await uploadDocument(ownerId, 'a.md', 'v1', []);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    let release!: () => void;
    gated.gate = new Promise((res) => { release = res; });
    const cycle = runArchiveCycle(gated);                       // 卡在 PUT
    await new Promise((res) => setTimeout(res, 30));            // 等 PUT 到达 gate
    // 注意：上传只发起不 await——它会阻塞在被 gate 卡住的 doc 锁上，先 await 会死锁（永远到不了 release）
    const upload = uploadDocument(ownerId, 'a.md', 'v2', []);   // PUT 窗口内到达，被 doc 锁挡住
    await new Promise((res) => setTimeout(res, 30));            // 等上传抵达锁队列
    release!();                                                 // 归档完成 → 锁释放 → 上传继续
    await cycle;
    await upload;
    const row = getDoc(r.id);
    expect(row.storageTier).toBe('hot');
    expect(row.contentHash).toBe(sha256Hex('v2'));
    const { readFile } = await import('../src/lib/server/storage');
    expect(await readFile(row.storagePath!)).toBe('v2');
    const fts = sqlite.prepare('SELECT content FROM docs_fts WHERE doc_id = ?').get(r.id) as { content: string };
    expect(fts.content).toBe('v2');
    expect(gated.data.size).toBe(0);                            // 旧 v1 对象被覆盖上传清理
});

test('竞态：回热 GET 窗口内覆盖上传 → FTS 不倒退、终态 v2 一致（P1 回归）', async () => {
    const gated = new GatedMemoryStore();
    __setObjectStoreForTest(gated);
    const r = await uploadDocument(ownerId, 'a.md', 'v1', []);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    await runArchiveCycle(gated);                                // v1 落远端，tier=cold
    let release!: () => void;
    gated.gate = new Promise((res) => { release = res; });
    const rewarm = rewarmDocument(r.id);                         // 无 content → GET 卡 gate
    await new Promise((res) => setTimeout(res, 30));
    const upload = uploadDocument(ownerId, 'a.md', 'v2', []);    // GET 窗口内到达，被 doc 锁挡住（同样只发起不 await，防死锁）
    await new Promise((res) => setTimeout(res, 30));
    release!();                                                  // 回热完成 → 锁释放 → 上传继续
    await rewarm;
    await upload;
    const row = getDoc(r.id);
    expect(row.storageTier).toBe('hot');
    expect(row.contentHash).toBe(sha256Hex('v2'));
    const { readFile } = await import('../src/lib/server/storage');
    expect(await readFile(row.storagePath!)).toBe('v2');
    const fts = sqlite.prepare('SELECT content FROM docs_fts WHERE doc_id = ?').get(r.id) as { content: string };
    expect(fts.content).toBe('v2');                              // 索引不倒退回 v1
    expect(gated.data.size).toBe(0);
});
