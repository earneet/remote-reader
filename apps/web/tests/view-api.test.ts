import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';

import { resetDb } from './helpers';
const { POST } = await import('../src/routes/api/view/[id]/+server');

const TMP = `./data/test-view-${Date.now().toString(36)}`;
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

async function call(userId: string | null, id: string): Promise<Response> {
    return POST({
        locals: { user: userId ? { id: userId } : null },
        params: { id }
    } as Parameters<typeof POST>[0]);
}

test('无 session → 401', async () => {
    await expect(call(null, 'x')).rejects.toMatchObject({ status: 401 });
});

test('文档不存在 → 404', async () => {
    await expect(call(ownerId, 'nonexistent')).rejects.toMatchObject({ status: 404 });
});

test('他人文档 → 404（不泄露存在性）', async () => {
    const other = generateId();
    db.insert(schema.users).values({
        id: other, email: `t2-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    await expect(call(other, a.id)).rejects.toMatchObject({ status: 404 });
});

test('folder → 404', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['fold']); // 顺带建 folder 'fold'
    const folder = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.type, 'folder'))).get()!;
    await expect(call(ownerId, folder.id)).rejects.toMatchObject({ status: 404 });
});

test('成功 → 204 且库内 owner_viewed_at 更新', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const before = Date.now();
    const r = await call(ownerId, a.id);
    expect(r.status).toBe(204);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, a.id)).get()!;
    expect(row.ownerViewedAt).toBeGreaterThanOrEqual(before);
});
