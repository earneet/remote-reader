import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { db, schema } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { writeFile } from '../src/lib/server/storage';

const { load } = await import('../src/routes/d/[id]/+page.server');

const TMP = `./data/test-dview-${Date.now().toString(36)}`;

beforeEach(() => {
    process.env.DATA_DIR = TMP;
    db.delete(schema.shareLinks).run();
    db.delete(schema.documents).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.users).run();
});

afterEach(() => {
    try {
        rmSync(TMP, { recursive: true, force: true });
    } catch {}
});

function insertUser(id: string): void {
    db.insert(schema.users).values({
        id, email: `t-${id}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
}

function insertDoc(ownerId: string, name: string, diskPath: string): string {
    const id = generateId();
    db.insert(schema.documents).values({
        id, ownerId, parentId: null, name, type: 'file',
        storagePath: diskPath, contentHash: null, sizeBytes: null,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    return id;
}

function mkEvent(userId: string | null, docId: string, headers: Record<string, string> = {}) {
    return {
        locals: userId ? { user: { id: userId } } : { user: null },
        params: { id: docId },
        setHeaders: (h: Record<string, string>) => Object.assign(headers, h)
    } as unknown as Parameters<typeof load>[0];
}

test('owner 查看自己的文档：返回渲染 html + cache-control no-store', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const diskPath = join(TMP, ownerId, 'doc.md');
    await writeFile(diskPath, '# Hello');
    const docId = insertDoc(ownerId, 'doc.md', diskPath);
    const headers: Record<string, string> = {};
    const result = (await load(mkEvent(ownerId, docId, headers))) as { title: string; html: string };
    expect(result.title).toBe('doc.md');
    expect(result.html).toContain('<h1>Hello</h1>');
    expect(headers['cache-control']).toBe('no-store');
});

test('非 owner 查看 → 404（不泄露存在性）', async () => {
    const ownerId = generateId();
    const otherId = generateId();
    insertUser(ownerId);
    insertUser(otherId);
    const docId = insertDoc(ownerId, 'secret.md', join(TMP, ownerId, 'secret.md'));
    await expect(load(mkEvent(otherId, docId))).rejects.toMatchObject({ status: 404 });
});

test('未登录 → 重定向 /login（302）', async () => {
    await expect(load(mkEvent(null, 'whatever'))).rejects.toMatchObject({ status: 302 });
});

test('磁盘文件缺失 → 404（M11）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const docId = insertDoc(ownerId, 'gone.md', '/nonexistent/path/gone.md');
    await expect(load(mkEvent(ownerId, docId))).rejects.toMatchObject({ status: 404 });
});
