import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';
import { sharedDocIds } from '../src/lib/server/shares';

import { resetDb } from './helpers';
const { POST, DELETE } = await import('../src/routes/api/share/[id]/+server');

const TMP = `./data/test-share-${Date.now().toString(36)}`;
let ownerId: string;

beforeEach(() => {
    process.env.DATA_DIR = TMP;
    resetDb();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId, email: `t-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
});

afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

async function post(userId: string | null, id: string): Promise<Response> {
    return POST({
        locals: { user: userId ? { id: userId } : null },
        params: { id }
    } as Parameters<typeof POST>[0]);
}

async function del(userId: string | null, id: string): Promise<Response> {
    return DELETE({
        locals: { user: userId ? { id: userId } : null },
        params: { id }
    } as Parameters<typeof DELETE>[0]);
}

test('POST 无 session → 401', async () => {
    await expect(post(null, 'x')).rejects.toMatchObject({ status: 401 });
});

test('POST 他人文档 / 不存在 / folder → 404（不泄露存在性）', async () => {
    const other = generateId();
    db.insert(schema.users).values({
        id: other, email: `t2-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    await uploadDocument(ownerId, 'b.md', 'y', ['fold']);
    const folder = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.type, 'folder'))).get()!;
    await expect(post(other, a.id)).rejects.toMatchObject({ status: 404 });
    await expect(post(ownerId, 'nonexistent')).rejects.toMatchObject({ status: 404 });
    await expect(post(ownerId, folder.id)).rejects.toMatchObject({ status: 404 });
});

test('POST owner file → 200 { url }，复用上传已建链接；重复调用同 URL（get-or-create）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const r1 = await post(ownerId, a.id);
    expect(r1.status).toBe(200);
    const u1 = await r1.json() as { url: string };
    expect(u1.url).toBe(a.url);
    const r2 = await post(ownerId, a.id);
    const u2 = await r2.json() as { url: string };
    expect(u2.url).toBe(u1.url);
});

test('POST 撤销后再取 → 新 URL（旧链接不复活）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const u1 = await (await post(ownerId, a.id)).json() as { url: string };
    await del(ownerId, a.id);
    const u2 = await (await post(ownerId, a.id)).json() as { url: string };
    expect(u2.url).not.toBe(u1.url);
});

test('DELETE 无 session → 401；他人文档 → 404', async () => {
    const other = generateId();
    db.insert(schema.users).values({
        id: other, email: `t3-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    await expect(del(null, a.id)).rejects.toMatchObject({ status: 401 });
    await expect(del(other, a.id)).rejects.toMatchObject({ status: 404 });
    expect(sharedDocIds(ownerId, [a.id]).size).toBe(1);
});

test('DELETE owner → 200 {ok:true} 链接全失效且幂等', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const r = await del(ownerId, a.id);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
    expect(sharedDocIds(ownerId, [a.id]).size).toBe(0);
    const r2 = await del(ownerId, a.id);
    expect(r2.status).toBe(200);
});
