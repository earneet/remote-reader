import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';
import { setDocTags } from '../src/lib/server/tags';

const { GET } = await import('../src/routes/api/recent/+server');

const TMP = `./data/test-recent-${Date.now().toString(36)}`;
let ownerId: string;

beforeEach(() => {
    process.env.DATA_DIR = TMP;
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.documents).run();
    db.delete(schema.inviteCodes).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId, email: `t-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
});

afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

function setUpdatedAt(id: string, ts: number): void {
    db.update(schema.documents).set({ updatedAt: ts }).where(eq(schema.documents.id, id)).run();
}

async function call(userId: string | null, query = ''): Promise<Response> {
    return GET({
        locals: { user: userId ? { id: userId } : null },
        url: new URL(`http://localhost/api/recent${query}`)
    } as Parameters<typeof GET>[0]);
}

test('未登录 → 401', async () => {
    await expect(call(null)).rejects.toMatchObject({ status: 401 });
});

test('返回 updated_at DESC 列表且内嵌 tags', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setUpdatedAt(a.id, T);
    setUpdatedAt(b.id, T + 1);
    await setDocTags(ownerId, a.id, ['周报']);
    const r = await call(ownerId);
    expect(r.status).toBe(200);
    const body = await r.json() as { items: { name: string; tags: { name: string }[] }[] & Record<string, unknown>[] };
    expect(body.items.map((i) => i.name)).toEqual(['b.md', 'a.md']);
    expect(body.items.find((i) => i.name === 'a.md')!.tags.map((t) => t.name)).toEqual(['周报']);
    // P2-7：DTO 边界——服务器内部字段不进载荷
    for (const key of ['storagePath', 'contentHash', 'lastViewedAt', 'archivedAt']) {
        expect(body.items.every((i) => !(key in i))).toBe(true);
    }
});

test('before cursor：返回 cursor 之后（更旧）的行', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setUpdatedAt(a.id, T);
    setUpdatedAt(b.id, T - 10);
    const r = await call(ownerId, `?before=${T}_${a.id}`);
    const body = await r.json() as { items: { name: string }[] };
    expect(body.items.map((i) => i.name)).toEqual(['b.md']);
});

test('非法 before → 400', async () => {
    await expect(call(ownerId, '?before=abc')).rejects.toMatchObject({ status: 400 });
});

test('before 空 id（?before=123_）→ 400', async () => {
    await expect(call(ownerId, '?before=123_')).rejects.toMatchObject({ status: 400 });
});

test('非法 limit → 400', async () => {
    await expect(call(ownerId, '?limit=abc')).rejects.toMatchObject({ status: 400 });
});

test('limit 生效：?limit=1 只返回 1 条', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', []);
    await uploadDocument(ownerId, 'b.md', 'y', []);
    const r = await call(ownerId, '?limit=1');
    const body = await r.json() as { items: unknown[] };
    expect(body.items.length).toBe(1);
});

test('owner 隔离：只返回自己的文档', async () => {
    const other = generateId();
    db.insert(schema.users).values({
        id: other, email: `t2-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    await uploadDocument(ownerId, 'mine.md', 'x', []);
    await uploadDocument(other, 'theirs.md', 'y', []);
    const r = await call(ownerId);
    const body = await r.json() as { items: { name: string }[] };
    expect(body.items.map((i) => i.name)).toEqual(['mine.md']);
});

test('超大数字 cursor 不 500（驱动绑定契约回归锁）', async () => {
    const r = await call(ownerId, `?before=${'9'.repeat(30)}_x`);
    expect(r.status).toBe(200);
    const body = await r.json() as { items: unknown[] };
    expect(Array.isArray(body.items)).toBe(true);
});

// ===== sort=viewed（「最近浏览」spec §6.2） =====

function setOwnerViewedAt(id: string, ts: number | null): void {
    db.update(schema.documents).set({ ownerViewedAt: ts }).where(eq(schema.documents.id, id)).run();
}

test('sort=viewed：按 owner_viewed_at DESC，未浏览不出现（updated 再新也不入序）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []); // 未浏览
    const T = 1_700_000_000_000;
    setUpdatedAt(b.id, T + 100);
    setOwnerViewedAt(a.id, T);
    const r = await call(ownerId, '?sort=viewed');
    const body = await r.json() as { items: { name: string }[] };
    expect(body.items.map((i) => i.name)).toEqual(['a.md']);
});

test('sort=viewed：before cursor 按 owner_viewed_at 解释', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setOwnerViewedAt(a.id, T);
    setOwnerViewedAt(b.id, T - 10);
    const r = await call(ownerId, `?sort=viewed&before=${T}_${a.id}`);
    const body = await r.json() as { items: { name: string }[] };
    expect(body.items.map((i) => i.name)).toEqual(['b.md']);
});

test('非法 sort → 400', async () => {
    await expect(call(ownerId, '?sort=bogus')).rejects.toMatchObject({ status: 400 });
});

test('缺省 sort 默认 updated（回归锁）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    setOwnerViewedAt(b.id, null);
    const T = 1_700_000_000_000;
    setUpdatedAt(a.id, T);
    setUpdatedAt(b.id, T + 5);
    const r = await call(ownerId);
    const body = await r.json() as { items: { name: string }[] };
    expect(body.items.map((i) => i.name)).toEqual(['b.md', 'a.md']);
});
