import { test, expect, beforeEach, afterAll } from 'vitest';
import { db, schema } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { writeFile } from '../src/lib/server/storage';
import { createShareLink } from '../src/lib/server/shares';
import { join } from 'node:path';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { resetDb } from './helpers';
// DATA_DIR 隔离：writeFile 不设会写进默认 ./data/documents 永久残留（审查 P2-1）
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-shareview-'));
process.env.DATA_DIR = DIR;
afterAll(() => {
    delete process.env.DATA_DIR;
    fs.rmSync(DIR, { recursive: true, force: true });
});
const { load } = await import('../src/routes/s/[token]/+page.server');

beforeEach(() => {
    resetDb();
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
    // M1：撤销 share token 后浏览器/CDN/bfcache 不得回放——headers 须 no-store（与 /d/ 侧对称）
    const headers: Record<string, string> = {};
    const result = (await load({ locals: { user: null }, params: { token }, setHeaders: (h: Record<string, string>) => Object.assign(headers, h) } as unknown as Parameters<typeof load>[0])) as { title: string; html: string };
    expect(headers['cache-control']).toBe('no-store');
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

// ===== 「最近浏览」写入侧（spec §7.1） =====

test('load 返回 id 与 ownerView：owner session → true，无 session → false', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const diskPath = join(process.env.DATA_DIR ?? './data/documents', ownerId, 'a.md');
    await writeFile(diskPath, '# T');
    const docId = generateId();
    db.insert(schema.documents).values({
        id: docId, ownerId, parentId: null, name: 'a.md', type: 'file',
        storagePath: diskPath, contentHash: null, sizeBytes: null,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    const { token } = await createShareLink(docId);
    const hit = (await load({
        locals: { user: { id: ownerId } }, params: { token }, setHeaders: () => {}
    } as unknown as Parameters<typeof load>[0])) as { id: string; ownerView: boolean };
    expect(hit.id).toBe(docId);
    expect(hit.ownerView).toBe(true);
    const anon = (await load({
        locals: { user: null }, params: { token }, setHeaders: () => {}
    } as unknown as Parameters<typeof load>[0])) as { ownerView: boolean };
    expect(anon.ownerView).toBe(false);
});
