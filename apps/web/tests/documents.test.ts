import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { db, schema, sqlite } from '../src/lib/server/db';
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
import { indexDoc } from '../src/lib/server/fts';
import { setDocTags } from '../src/lib/server/tags';
import { runArchiveCycle } from '../src/lib/server/tiering';
import { MemoryObjectStore, __setObjectStoreForTest, objectKeyFor } from '../src/lib/server/object-store';
import { join, dirname } from 'node:path';
import { eq, and, isNull } from 'drizzle-orm';

let ownerId: string;
let store: MemoryObjectStore;
const DAY = 86_400_000;
const TMP_DOCS = `./data/test-docs-${Date.now().toString(36)}`;

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
        id: ownerId,
        email: `t-${Date.now()}@x.com`,
        passwordHash: await hashPassword('x'),
        role: 'member',
        createdAt: Date.now()
    }).run();
    store = new MemoryObjectStore();
    __setObjectStoreForTest(store);
});

afterEach(() => {
    try {
        rmSync(TMP_DOCS, { recursive: true, force: true });
    } catch {}
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    __setObjectStoreForTest(undefined);
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
    expect(renameNode(ownerId, r.id, 'renamed.md').ok).toBe(true);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get();
    expect(row?.name).toBe('renamed.md');
});

test('renameNode 非 owner 返回 not_found 不生效', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    const res = renameNode('other', r.id, 'renamed.md');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('not_found');
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()?.name).toBe('a.md');
});

test('renameNode 拒绝同父同名冲突（M9）', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const res = renameNode(ownerId, b.id, 'a.md');
    expect(res.ok).toBe(false);
    expect(res.code).toBe('conflict');
});

test('moveNode 拒绝目标位置同名冲突（M9）', async () => {
    await uploadDocument(ownerId, 'f.md', 'v1', ['dst']);
    await uploadDocument(ownerId, 'f.md', 'v2', []);
    const dst = folderByName('dst')!;
    const rootF = db.select().from(schema.documents)
        .where(and(eq(schema.documents.name, 'f.md'), eq(schema.documents.type, 'file'), isNull(schema.documents.parentId)))
        .get()!;
    const res = moveNode(ownerId, rootF.id, dst.id);
    expect(res.ok).toBe(false);
    expect(res.code).toBe('conflict');
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

test('deleteNode 删 file 同步清 docs_fts 与 document_tags', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    indexDoc(r.id, 'a.md', 'searchable text here');
    setDocTags(ownerId, r.id, ['t1']);
    const hit = () => (sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"searchable"') as { doc_id: string }[]);
    expect(hit().length).toBe(1);
    deleteNode(ownerId, r.id);
    expect(hit().length).toBe(0);
    expect(db.select().from(schema.documentTags).all().length).toBe(0);
});

test('uploadDocument 新建文档写入 FTS（可搜）', async () => {
    await uploadDocument(ownerId, 'a.md', 'unique_token_xyz', []);
    const r = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"unique_token_xyz"') as { doc_id: string }[];
    expect(r.length).toBe(1);
});

test('uploadDocument 覆盖更新 FTS（搜新内容、搜不到旧内容）', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'old_content_here', []);
    await uploadDocument(ownerId, 'a.md', 'new_content_here', []);
    const oldHit = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"old_content_here"') as { doc_id: string }[];
    const newHit = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"new_content_here"') as { doc_id: string }[];
    expect(oldHit.length).toBe(0);
    expect(newHit.length).toBe(1);
    expect(newHit[0].doc_id).toBe(r.id);
});

test('uploadDocument 相同内容（skip）不重复写 FTS', async () => {
    await uploadDocument(ownerId, 'a.md', 'same', []);
    const before = sqlite.prepare('SELECT COUNT(*) c FROM docs_fts').get() as { c: number };
    await uploadDocument(ownerId, 'a.md', 'same', []);
    const after = sqlite.prepare('SELECT COUNT(*) c FROM docs_fts').get() as { c: number };
    expect(after.c).toBe(before.c);
});

test('listChildren 默认排序：folder 优先，同层 file 按 updated_at 倒序', async () => {
    await uploadDocument(ownerId, 'in_zfolder.md', 'z', ['zfolder']);
    const older = await uploadDocument(ownerId, 'aaa.md', 'x', []);
    db.update(schema.documents).set({ updatedAt: 1000 }).where(eq(schema.documents.id, older.id)).run();
    const newer = await uploadDocument(ownerId, 'bbb.md', 'y', []);
    db.update(schema.documents).set({ updatedAt: 2000 }).where(eq(schema.documents.id, newer.id)).run();
    const children = listChildren(ownerId, null);
    expect(children[0].type).toBe('folder');
    const files = children.filter(c => c.type === 'file');
    expect(files[0].name).toBe('bbb.md');
    expect(files[1].name).toBe('aaa.md');
});

// ── 冷热分层：写路径冷态交互 ────────────────────────────────
async function makeCold(content: string, name = 'c.md'): Promise<string> {
    const r = await uploadDocument(ownerId, name, content, []);
    db.update(schema.documents)
        .set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY })
        .where(eq(schema.documents.id, r.id)).run();
    await runArchiveCycle(store);
    return r.id;
}

test('冷文档·覆盖上传（新内容）→ 回热 + 本地 v2 + 删旧远端对象', async () => {
    const id = await makeCold('v1');
    const oldKey = objectKeyFor(db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!);
    expect(store.data.has(oldKey)).toBe(true);
    await uploadDocument(ownerId, 'c.md', 'v2', []);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!;
    expect(row.storageTier).toBe('hot');
    expect(row.contentHash).toBe(sha256Hex('v2'));
    const { readFile } = await import('../src/lib/server/storage');
    expect(await readFile(row.storagePath!)).toBe('v2');
    await new Promise((r) => setTimeout(r, 20)); // 旧对象删除 fire-and-forget
    expect(store.data.has(oldKey)).toBe(false);
});

test('冷文档·幂等命中（同内容）→ 保持冷态、不写盘、时间戳未动', async () => {
    const id = await makeCold('same');
    const before = db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!;
    await uploadDocument(ownerId, 'c.md', 'same', []);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!;
    expect(row.storageTier).toBe('cold');
    expect(row.updatedAt).toBe(before.updatedAt); // 时间戳未动
});

test('冷文档·重命名 → 仅 DB（name+storagePath 更新），不触碰磁盘/远端', async () => {
    const id = await makeCold('x', 'old.md');
    const row0 = db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!;
    const key = objectKeyFor(row0);
    const r = renameNode(ownerId, id, 'new.md');
    expect(r.ok).toBe(true);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!;
    expect(row.name).toBe('new.md');
    expect(row.storagePath).toBe(join(dirname(row0.storagePath!), 'new.md'));
    expect(store.data.has(key)).toBe(true); // 远端对象未动（key 不含 name）
});

test('冷文档·删除 → 行删除 + 远端对象删除', async () => {
    const id = await makeCold('gone');
    const key = objectKeyFor(db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!);
    deleteNode(ownerId, id);
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(store.data.has(key)).toBe(false);
});
