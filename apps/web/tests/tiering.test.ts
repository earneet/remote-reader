import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId, sha256Hex } from '../src/lib/server/auth';
import { uploadDocument, renameNode, deleteNode } from '../src/lib/server/documents';
import { isColdCandidate, runArchiveCycle, rewarmDocument, withDocLock, __clearArchiveSkipForTest } from '../src/lib/server/tiering';
import { MemoryObjectStore, __setObjectStoreForTest, objectKeyFor } from '../src/lib/server/object-store';
import { eq } from 'drizzle-orm';

import { resetDb } from './helpers';
const DAY = 86_400_000;
let ownerId: string;
let store: MemoryObjectStore;
const TMP_DOCS = `./data/test-tiering-${Date.now().toString(36)}`;

function getDoc(id: string) {
    return db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!;
}

beforeEach(async () => {
    process.env.DATA_DIR = TMP_DOCS;
    resetDb();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId, email: `t-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    store = new MemoryObjectStore();
    __setObjectStoreForTest(store);
    __clearArchiveSkipForTest();
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

test('竞态：回热 GET 窗口内重命名 → 翻转守卫拦截保持 cold，二次回热收敛到新路径（终审 MINOR 回归）', async () => {
    const gated = new GatedMemoryStore();
    __setObjectStoreForTest(gated);
    const r = await uploadDocument(ownerId, 'old.md', '# rn', []);
    db.update(schema.documents)
        .set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY })
        .where(eq(schema.documents.id, r.id)).run();
    await runArchiveCycle(gated);                                // cold，对象已上桶
    let release!: () => void;
    gated.gate = new Promise((res) => { release = res; });
    const rewarm = rewarmDocument(r.id);                         // 无 content → GET 卡 gate
    await new Promise((res) => setTimeout(res, 30));
    expect(renameNode(ownerId, r.id, 'new.md').ok).toBe(true);   // 同步 rename：行指向新路径（本地无文件可动）
    release!();
    await rewarm;
    let row = getDoc(r.id);                                      // 守卫拦截：不翻转、保持 cold、对象保留
    expect(row.storageTier).toBe('cold');
    expect(row.name).toBe('new.md');
    expect(gated.data.size).toBe(1);
    await rewarmDocument(r.id, '# rn');                          // 二次回热：fresh 行→新路径，自动收敛
    row = getDoc(r.id);
    expect(row.storageTier).toBe('hot');
    const { readFile } = await import('../src/lib/server/storage');
    expect(await readFile(row.storagePath!)).toBe('# rn');
    expect(gated.data.size).toBe(0);
    const fts = sqlite.prepare('SELECT content FROM docs_fts WHERE doc_id = ?').get(r.id) as { content: string };
    expect(fts.content).toBe('# rn');
});

test('!flipped 防御：归档 PUT 窗口内 deleteNode → 不翻转、best-effort 清刚 PUT 对象、无孤儿', async () => {
    const gated = new GatedMemoryStore();
    __setObjectStoreForTest(gated);
    const r = await uploadDocument(ownerId, 'a.md', 'v1', []);
    db.update(schema.documents)
        .set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY })
        .where(eq(schema.documents.id, r.id)).run();
    let release!: () => void;
    gated.gate = new Promise((res) => { release = res; });
    const cycle = runArchiveCycle(gated);                        // 卡在 PUT
    await new Promise((res) => setTimeout(res, 30));
    deleteNode(ownerId, r.id);                                   // 同步删除：行+FTS+本地文件（tier 仍 hot → rmSync 本地）
    release!();
    expect(await cycle).toBe(0);                                 // 守卫拦截：UPDATE 落空 → skipped，计数 0
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()).toBeUndefined();
    expect(gated.data.size).toBe(0);                             // 刚 PUT 的对象被清理——不留永久孤儿
});

test('!flipped 防御：回热窗口内行被删 → 不恢复 FTS、不删远端，静默返回', async () => {
    const gated = new GatedMemoryStore();
    __setObjectStoreForTest(gated);
    const r = await uploadDocument(ownerId, 'b.md', 'v1', []);
    db.update(schema.documents)
        .set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY })
        .where(eq(schema.documents.id, r.id)).run();
    await runArchiveCycle(gated);                                // cold
    let release!: () => void;
    gated.gate = new Promise((res) => { release = res; });
    const rewarm = rewarmDocument(r.id);                         // GET 卡 gate
    await new Promise((res) => setTimeout(res, 30));
    // 模拟行已被删除（deleteNode 语义的 DB 部分；保留桶对象以直达 !flipped 分支）
    sqlite.prepare('DELETE FROM docs_fts WHERE doc_id = ?').run(r.id);
    db.delete(schema.shareLinks).where(eq(schema.shareLinks.documentId, r.id)).run();
    db.delete(schema.documents).where(eq(schema.documents.id, r.id)).run();
    release!();
    await rewarm;                                                // 不抛错
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()).toBeUndefined();
    const ftsCnt = (sqlite.prepare('SELECT COUNT(*) AS c FROM docs_fts WHERE doc_id = ?').get(r.id) as { c: number }).c;
    expect(ftsCnt).toBe(0);                                      // 未插入孤儿 FTS 行（无守卫时会插入）
    expect(gated.data.size).toBe(1);                             // 未删远端对象（留孤儿，无害）
});

// ===== P2-8：永久 skip 候选的饥饿防护 =====

test('P2-8 归档饥饿防护：>50 个坏候选暂缓重试，不阻塞后面的正常冷文档', async () => {
    for (let i = 0; i < 51; i++) {
        const r = await uploadDocument(ownerId, `bad-${i}.md`, 'v1', []);
        const row = getDoc(r.id);
        db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
        const { writeFile } = await import('../src/lib/server/storage');
        await writeFile(row.storagePath!, 'tampered');
    }
    const good = await uploadDocument(ownerId, 'good.md', 'clean', []);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, good.id)).run();
    // 首轮：坏候选占批全 skip 并登记暂缓（good 可能未入批）
    expect(await runArchiveCycle(store)).toBe(0);
    // 次轮：坏候选被暂缓出候选集，good 正常归档——修复前 good 会永远饿死
    expect(await runArchiveCycle(store)).toBe(1);
    expect(getDoc(good.id).storageTier).toBe('cold');
});

test('P2-8 暂缓 24h 后坏候选恢复重试（窗口过期自动出列）', async () => {
    __clearArchiveSkipForTest(); // 直接清空暂缓表模拟窗口过期
    const r = await uploadDocument(ownerId, 'bad.md', 'v1', []);
    const row = getDoc(r.id);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    const { writeFile } = await import('../src/lib/server/storage');
    await writeFile(row.storagePath!, 'tampered');
    expect(await runArchiveCycle(store)).toBe(0);
    expect(await runArchiveCycle(store)).toBe(0); // 暂缓期内不再重试
    __clearArchiveSkipForTest();
    // 窗口清空（模拟过期）后重新成为候选（仍 skip，因为盘内容还是坏的）
    expect(await runArchiveCycle(store)).toBe(0);
});

// ===== 备忘：归档 flip 补 storagePath 守卫（与 rewarm 对称） =====

test('归档 PUT 窗口内 renameNode → 翻转守卫拦下，保持 hot，次轮按新路径收敛', async () => {
    const gated = new GatedMemoryStore();
    __setObjectStoreForTest(gated);
    const r = await uploadDocument(ownerId, 'old.md', '# arc', []);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    let release!: () => void;
    gated.gate = new Promise((res) => { release = res; });
    const cycle = runArchiveCycle(gated);                        // 卡在 PUT
    await new Promise((res) => setTimeout(res, 30));
    expect(renameNode(ownerId, r.id, 'new.md').ok).toBe(true);   // PUT 窗口内改名（盘+DB 均新路径）
    release!();
    await cycle;
    const row = getDoc(r.id);
    expect(row.storageTier).toBe('hot');                          // 未翻转：不造"行 cold 指旧路径"
    expect(row.name).toBe('new.md');
    expect(gated.data.size).toBe(0);                              // 刚 PUT 的对象被 !flipped 分支清理
    const { existsSync } = await import('node:fs');
    expect(existsSync(row.storagePath!)).toBe(true);              // 本地文件在新路径完好
    // 次轮按新状态正常归档（rename 会刷新 updatedAt，需重新老化）
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    expect(await runArchiveCycle(gated)).toBe(1);
    expect(getDoc(r.id).storageTier).toBe('cold');
});
