import { test, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, schema } from '../src/lib/server/db';
import { hashPassword, generateId, sha256Hex } from '../src/lib/server/auth';
import {
    uploadDocument,
    listChildren,
    listFolders,
    getOwnedDocument,
    renameNode,
    moveNode,
    deleteNode
} from '../src/lib/server/documents';
import { eq, and } from 'drizzle-orm';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '../src/lib/server/db/migrations');

let ownerId: string;
const TMP_DOCS = `./data/test-docs-${Date.now().toString(36)}`;

beforeAll(() => {
    migrate(db, { migrationsFolder });
});

beforeEach(async () => {
    process.env.DATA_DIR = TMP_DOCS;
    db.delete(schema.shareLinks).run();
    db.delete(schema.documents).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId,
        email: `t-${Date.now()}@x.com`,
        passwordHash: await hashPassword('x'),
        role: 'member',
        createdAt: Date.now()
    }).run();
});

afterEach(() => {
    try {
        rmSync(TMP_DOCS, { recursive: true, force: true });
    } catch {}
});

test('首次上传创建文档并返回 url', async () => {
    const r = await uploadDocument(ownerId, 'weekly.md', '# v1', ['reports']);
    expect(r.id).toBeTruthy();
    expect(r.url).toMatch(/\/s\//);
});

test('相同内容重复上传：id 不变、url 仍有效', async () => {
    const a = await uploadDocument(ownerId, 'd.md', 'same', []);
    const b = await uploadDocument(ownerId, 'd.md', 'same', []);
    expect(b.id).toBe(a.id);
    expect(b.url).toMatch(/\/s\//);
});

test('相同内容重复上传不新建文档行（幂等）', async () => {
    await uploadDocument(ownerId, 'd.md', 'same', []);
    await uploadDocument(ownerId, 'd.md', 'same', []);
    const files = db.select().from(schema.documents).where(eq(schema.documents.type, 'file')).all();
    expect(files.length).toBe(1);
    const shares = db.select().from(schema.shareLinks).all();
    expect(shares.length).toBe(1);
});

test('不同内容覆盖：id 不变、hash 更新为最新内容', async () => {
    const a = await uploadDocument(ownerId, 'd.md', 'v1', []);
    await uploadDocument(ownerId, 'd.md', 'v2', []);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, a.id)).get();
    expect(row?.contentHash).toBe(sha256Hex('v2'));
    expect(row?.sizeBytes).toBe(2);
});

test('嵌套路径级联创建文件夹且复用（不重复建）', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['reports', '2026']);
    await uploadDocument(ownerId, 'b.md', 'y', ['reports', '2026']);
    const folders = db.select().from(schema.documents).where(eq(schema.documents.type, 'folder')).all();
    expect(folders.length).toBe(2);
});

test('根目录文件（pathSegments 为空）parentId 为 null', async () => {
    const r = await uploadDocument(ownerId, 'root.md', '# hi', []);
    expect(r.url).toMatch(/\/s\//);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get();
    expect(row?.parentId).toBe(null);
    expect(row?.type).toBe('file');
});

test('listChildren 返回指定 folder 的子项', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['reports']);
    await uploadDocument(ownerId, 'b.md', 'y', ['reports']);
    const reports = db.select().from(schema.documents)
        .where(and(eq(schema.documents.name, 'reports'), eq(schema.documents.type, 'folder'))).get();
    const children = listChildren(ownerId, reports!.id);
    expect(children.length).toBe(2);
});

test('listChildren 根目录（parentId=null）返回根级 file+folder', async () => {
    await uploadDocument(ownerId, 'root.md', 'x', []);
    await uploadDocument(ownerId, 'sub.md', 'y', ['sub']);
    const root = listChildren(ownerId, null);
    expect(root.length).toBe(2);
    expect(root.some((d) => d.name === 'root.md' && d.type === 'file')).toBe(true);
    expect(root.some((d) => d.name === 'sub' && d.type === 'folder')).toBe(true);
});

test('listFolders 返回 owner 的所有 folder（不含 file）', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['reports']);
    await uploadDocument(ownerId, 'b.md', 'y', ['notes']);
    const folders = listFolders(ownerId);
    expect(folders.length).toBe(2);
    expect(folders.every((d) => d.type === 'folder')).toBe(true);
});

test('getOwnedDocument 仅返回属于该 owner 的文档', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    expect(getOwnedDocument(r.id, ownerId)).toBeTruthy();
    expect(getOwnedDocument(r.id, 'other-user')).toBeUndefined();
});

function folderByName(name: string) {
    return db.select().from(schema.documents)
        .where(and(eq(schema.documents.name, name), eq(schema.documents.type, 'folder')))
        .get();
}
function docByName(name: string) {
    return db.select().from(schema.documents)
        .where(and(eq(schema.documents.name, name), eq(schema.documents.type, 'file')))
        .get();
}

test('renameNode 修改名称', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    expect(renameNode(ownerId, r.id, 'renamed.md')).toBe(true);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get();
    expect(row?.name).toBe('renamed.md');
});

test('renameNode 非 owner 返回 false 不生效', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    expect(renameNode('other', r.id, 'renamed.md')).toBe(false);
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()?.name).toBe('a.md');
});

test('moveNode 移到另一 folder', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['src']);
    await uploadDocument(ownerId, 'b.md', 'y', ['dst']);
    const dst = folderByName('dst')!;
    const a = docByName('a.md')!;
    const r = moveNode(ownerId, a.id, dst.id);
    expect(r.ok).toBe(true);
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, a.id)).get()?.parentId).toBe(dst.id);
});

test('moveNode 拒绝移入自身子孙（防环路）', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['p', 'c']);
    const p = folderByName('p')!;
    const c = folderByName('c')!;
    const r = moveNode(ownerId, p.id, c.id);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
});

test('moveNode 非 owner 拒绝', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['dst']);
    const dst = folderByName('dst')!;
    const a = docByName('a.md')!;
    expect(moveNode('other', a.id, dst.id).ok).toBe(false);
});

test('deleteNode 删 file 同时清 share_links', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    expect(db.select().from(schema.shareLinks).all().length).toBe(1);
    deleteNode(ownerId, r.id);
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()).toBeUndefined();
    expect(db.select().from(schema.shareLinks).all().length).toBe(0);
});

test('deleteNode 删 folder 级联删子孙 + 磁盘文件 + share_links', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', ['p', 'c']);
    const a = db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get();
    const diskPath = a!.storagePath!;
    const p = folderByName('p')!;
    deleteNode(ownerId, p.id);
    expect(db.select().from(schema.documents).all().length).toBe(0);
    expect(db.select().from(schema.shareLinks).all().length).toBe(0);
    const { existsSync } = await import('node:fs');
    expect(existsSync(diskPath)).toBe(false);
});

test('deleteNode 删 file 后磁盘文件删除', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    const doc = db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get();
    const path = doc!.storagePath!;
    deleteNode(ownerId, r.id);
    const { existsSync } = await import('node:fs');
    expect(existsSync(path)).toBe(false);
});

test('deleteNode 非 owner 不删', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    deleteNode('other', r.id);
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()).toBeTruthy();
});

test('deleteNode 不存在的 id 静默返回', () => {
    expect(() => deleteNode(ownerId, 'nonexistent-id')).not.toThrow();
});

test('moveNode 遇到 parentId 环（DB 损坏）触发深度上限，安全拒绝', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['p1']);
    await uploadDocument(ownerId, 'b.md', 'y', ['p2']);
    const p1 = folderByName('p1')!;
    const p2 = folderByName('p2')!;
    db.update(schema.documents).set({ parentId: p2.id }).where(eq(schema.documents.id, p1.id)).run();
    db.update(schema.documents).set({ parentId: p1.id }).where(eq(schema.documents.id, p2.id)).run();
    await uploadDocument(ownerId, 'c.md', 'z', []);
    const c = docByName('c.md')!;
    const r = moveNode(ownerId, c.id, p1.id);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
});

test('deleteNode 遇到 parentId 环（DB 损坏）触发深度上限，不无限循环', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['p1']);
    await uploadDocument(ownerId, 'b.md', 'y', ['p2']);
    const p1 = folderByName('p1')!;
    const p2 = folderByName('p2')!;
    db.update(schema.documents).set({ parentId: p2.id }).where(eq(schema.documents.id, p1.id)).run();
    db.update(schema.documents).set({ parentId: p1.id }).where(eq(schema.documents.id, p2.id)).run();
    expect(() => deleteNode(ownerId, p1.id)).not.toThrow();
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, p1.id)).get()).toBeUndefined();
});
