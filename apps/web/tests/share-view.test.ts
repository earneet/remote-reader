import { test, expect, beforeEach } from 'vitest';
import { db, schema } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { writeFile } from '../src/lib/server/storage';
import { createShareLink } from '../src/lib/server/shares';
import { join } from 'node:path';

const { load } = await import('../src/routes/s/[token]/+page.server');

beforeEach(() => {
    db.delete(schema.shareLinks).run();
    db.delete(schema.documents).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.users).run();
});

function insertUser(id: string): void {
    db.insert(schema.users).values({
        id, email: `t-${id}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
}

test('有效 token 返回渲染 html（#32）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const diskPath = join(process.env.DATA_DIR ?? './data/documents', ownerId, 'a.md');
    await writeFile(diskPath, '# Title');
    const docId = generateId();
    db.insert(schema.documents).values({
        id: docId, ownerId, parentId: null, name: 'a.md', type: 'file',
        storagePath: diskPath, contentHash: null, sizeBytes: null,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    const { token } = await createShareLink(docId);
    const result = (await load({ params: { token }, setHeaders: () => {} } as unknown as Parameters<typeof load>[0])) as { title: string; html: string };
    expect(result.title).toBe('a.md');
    expect(result.html).toContain('<h1>Title</h1>');
});

test('无效 token → 404（#32）', async () => {
    await expect(
        load({ params: { token: 'nope' }, setHeaders: () => {} } as unknown as Parameters<typeof load>[0])
    ).rejects.toMatchObject({ status: 404 });
});

test('磁盘文件缺失 → 404（M11）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const docId = generateId();
    db.insert(schema.documents).values({
        id: docId, ownerId, parentId: null, name: 'gone.md', type: 'file',
        storagePath: '/nonexistent/path/gone.md', contentHash: null, sizeBytes: null,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    const { token } = await createShareLink(docId);
    await expect(
        load({ params: { token }, setHeaders: () => {} } as unknown as Parameters<typeof load>[0])
    ).rejects.toMatchObject({ status: 404 });
});
