import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';
import { runArchiveCycle } from '../src/lib/server/tiering';
import { MemoryObjectStore, __setObjectStoreForTest, objectKeyFor } from '../src/lib/server/object-store';
import { createShareLink } from '../src/lib/server/shares';
import { eq } from 'drizzle-orm';

import { resetDb } from './helpers';
const DAY = 86_400_000;
let ownerId: string;
let store: MemoryObjectStore;
const TMP_DOCS = `./data/test-view-${Date.now().toString(36)}`;

const shareLoad = (await import('../src/routes/s/[token]/+page.server')).load;

function getDocRow() {
    return db.select().from(schema.documents).where(eq(schema.documents.ownerId, ownerId)).get()!;
}

function callShareLoad(token: string) {
    return shareLoad({ locals: { user: null }, params: { token }, setHeaders: () => {} } as unknown as Parameters<typeof shareLoad>[0]);
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
});

afterEach(() => {
    try { rmSync(TMP_DOCS, { recursive: true, force: true }); } catch {}
    __setObjectStoreForTest(undefined);
});

async function makeColdWithShare(content: string): Promise<string> {
    const r = await uploadDocument(ownerId, 'c.md', content, []);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY })
        .where(eq(schema.documents.id, r.id)).run();
    await runArchiveCycle(store);
    const { token } = await createShareLink(r.id); // 归档后 token 依然有效
    return token;
}

test('冷文档 + 有效 token → 正常渲染（内容来自远端）且触发异步回热', async () => {
    const token = await makeColdWithShare('# Cold View');
    const result = (await callShareLoad(token)) as { title: string; html: string };
    expect(result.html).toContain('<h1>Cold View</h1>');
    // 回热 fire-and-forget：轮询等待翻转（固定 sleep 在 CI 负载下会假红，回热链含 3 次真实磁盘 I/O）
    for (let i = 0; i < 100 && getDocRow().storageTier !== 'hot'; i++) {
        await new Promise((r) => setTimeout(r, 20));
    }
    expect(getDocRow().storageTier).toBe('hot');
    expect(store.data.size).toBe(0);
});

test('冷文档 + 远端不可达 → 503（区别于 404）', async () => {
    const token = await makeColdWithShare('# x');
    store.failGet = true;
    await expect(callShareLoad(token)).rejects.toMatchObject({ status: 503 });
});

test('冷文档 + 远端对象缺失 → 404 内容缺失', async () => {
    const token = await makeColdWithShare('# x');
    store.data.clear(); // 对象被误删
    await expect(callShareLoad(token)).rejects.toMatchObject({ status: 404 });
});

test('热文档访问 → last_viewed_at 刷新', async () => {
    const r = await uploadDocument(ownerId, 'h.md', '# Hot', []);
    const stale = Date.now() - 40 * DAY;
    db.update(schema.documents).set({ lastViewedAt: stale }).where(eq(schema.documents.id, r.id)).run();
    const { token } = await createShareLink(r.id);
    await callShareLoad(token);
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()!.lastViewedAt!).toBeGreaterThan(stale);
});

test('冷文档 storagePath 保留不再是 404 条件（守卫放宽）', async () => {
    const token = await makeColdWithShare('# guard');
    const result = (await callShareLoad(token)) as { html: string };
    expect(result.html).toContain('<h1>guard</h1>');
});

// ── 自愈兜底（spec §7，双 Agent 交叉审查发现：陈旧行判定与实际状态竞态防假 404）──

test('自愈：陈旧行判冷、读取期间他方已回热 → 回落本地，不假 404（P1 回归）', async () => {
    await makeColdWithShare('# Race');
    const stale = getDocRow(); // storageTier === 'cold' 的快照视图
    // 模拟另一请求已完成回热：本地已写 + DB 翻 hot + 远端对象已删
    const { writeFile } = await import('../src/lib/server/storage');
    await writeFile(stale.storagePath!, '# Race');
    db.update(schema.documents).set({ storageTier: 'hot' }).where(eq(schema.documents.id, stale.id)).run();
    store.data.clear();
    const { readDocumentContent } = await import('../src/lib/server/documents');
    // stale.storageTier === 'cold' → 远端 get 落空（ObjectNotFound）→ 重取行已是 hot → 回落本地
    expect(await readDocumentContent(stale)).toBe('# Race');
});

test('自愈：陈旧行判热、读取期间归档刚完成 → 转走远端，不假 404', async () => {
    const r = await uploadDocument(ownerId, 'h.md', '# HotRace', []);
    const stale = getDocRow(); // storageTier === 'hot' 的快照视图
    // 模拟归档刚完成：对象已上远端 + DB 翻 cold + 本地已删
    await store.put(objectKeyFor(stale), '# HotRace');
    db.update(schema.documents).set({ storageTier: 'cold' }).where(eq(schema.documents.id, r.id)).run();
    const { unlink } = await import('node:fs/promises');
    await unlink(stale.storagePath!);
    const { readDocumentContent } = await import('../src/lib/server/documents');
    // stale.storageTier === 'hot' → 本地 readFile ENOENT → 重取行已是 cold → 转远端拉取
    expect(await readDocumentContent(stale)).toBe('# HotRace');
});
