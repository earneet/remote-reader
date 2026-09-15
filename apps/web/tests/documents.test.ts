import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { db, schema, sqlite } from '../src/lib/server/db';
import { hashPassword, generateId, sha256Hex } from '../src/lib/server/auth';
import {
    uploadDocument,
    listChildren,
    listFolders,
    folderChildCounts,
    recentFiles,
    markOwnerViewed,
    getOwnedDocument,
    renameNode,
    moveNode,
    deleteNode,
    NameConflictError
} from '../src/lib/server/documents';
import { indexDoc } from '../src/lib/server/fts';
import { searchDocuments } from '../src/lib/server/search';
import { readFile } from '../src/lib/server/storage';
import { setDocTags } from '../src/lib/server/tags';
import { runArchiveCycle } from '../src/lib/server/tiering';
import { MemoryObjectStore, __setObjectStoreForTest, objectKeyFor } from '../src/lib/server/object-store';
import { join, dirname } from 'node:path';
import { eq, and, isNull } from 'drizzle-orm';

import { resetDb } from './helpers';
let ownerId: string;
let store: MemoryObjectStore;
const DAY = 86_400_000;
const TMP_DOCS = `./data/test-docs-${Date.now().toString(36)}`;

beforeEach(async () => {
    process.env.DATA_DIR = TMP_DOCS;
    resetDb();
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

test('renameNode 同步 docs_fts.name：旧名不再命中、新名可命中', async () => {
    await uploadDocument(ownerId, 'draft.md', '正文内容与查询词完全无关', []);
    const doc = db.select().from(schema.documents).where(eq(schema.documents.name, 'draft.md')).get()!;
    expect(renameNode(ownerId, doc.id, 'final.md').ok).toBe(true);
    expect(searchDocuments(ownerId, 'draft', []).length).toBe(0);
    expect(searchDocuments(ownerId, 'final', []).length).toBe(1);
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

// ── folderChildCounts：目录树子项计数 ────────────────────────

test('folderChildCounts 按直接子项聚合 folder/file 数', async () => {
    // 结构：reports/（1 文件 + 1 子文件夹 reports/2026）、reports/2026/（1 文件）、根（1 文件 + 1 文件夹）、
    // pf/（仅 1 个子文件夹 pf/sub，文件在 sub 里 → 纯文件夹父级）
    await uploadDocument(ownerId, 'r1.md', 'x', ['reports']);
    await uploadDocument(ownerId, 'y.md', 'y', ['reports', '2026']);
    await uploadDocument(ownerId, 'root.md', 'z', []);
    await uploadDocument(ownerId, 'pf.md', 'w', ['pf', 'sub']);
    const reports = folderByName('reports')!;
    const y2026 = folderByName('2026')!;
    const pf = folderByName('pf')!;
    const counts = folderChildCounts(ownerId);
    expect(counts.get(reports.id)).toEqual({ folders: 1, files: 1 });
    expect(counts.get(y2026.id)).toEqual({ folders: 0, files: 1 });
    expect(counts.get(pf.id)).toEqual({ folders: 1, files: 0 }); // 纯文件夹父级
});

test('folderChildCounts 空文件夹不入 map，有子项的准确计数', async () => {
    // empty-dir 里有 1 个 file 子项；truly-empty 直接插行、无任何子项
    await uploadDocument(ownerId, 'a.md', 'x', ['empty-dir']);
    const fid = generateId();
    db.insert(schema.documents).values({
        id: fid, ownerId, parentId: null, name: 'truly-empty', type: 'folder',
        storagePath: null, contentHash: null, sizeBytes: null,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    const counts = folderChildCounts(ownerId);
    expect(counts.get(fid)).toBeUndefined(); // 无子项的 folder 不出现在 map（UI 侧 ?? {0,0} 兜底）
    expect(counts.get(folderByName('empty-dir')!.id)).toEqual({ folders: 0, files: 1 });
});

test('folderChildCounts owner 隔离：不数别人的子项；无文档 owner 返回空 Map', async () => {
    await uploadDocument(ownerId, 'mine.md', 'x', ['shared-name']);
    // 另一个 owner：必须先建 users 行——documents.owner_id 有 FK → users.id 且 foreign_keys=ON（H3），
    // 直接插 documents 行会抛 FOREIGN KEY constraint failed
    db.insert(schema.users).values({
        id: 'user-x', email: 'user-x@t.com', passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    expect(folderChildCounts('user-x').size).toBe(0); // 空 owner：无任何文档 → 空 Map
    db.insert(schema.documents).values({
        id: generateId(), ownerId: 'user-x', parentId: null, name: 'fx', type: 'folder',
        storagePath: null, contentHash: null, sizeBytes: null,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    db.insert(schema.documents).values({
        id: generateId(), ownerId: 'user-x', parentId: db.select().from(schema.documents)
            .where(and(eq(schema.documents.ownerId, 'user-x'), eq(schema.documents.name, 'fx'))).get()!.id,
        name: 'child.md', type: 'file', storagePath: null, contentHash: null, sizeBytes: 1,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    const counts = folderChildCounts(ownerId);
    expect(counts.size).toBe(1); // 只有 shared-name，user-x 的子项不串
});

// ===== recentFiles（「最近文档」视图，spec §5.1） =====

function setUpdatedAt(id: string, ts: number): void {
    db.update(schema.documents).set({ updatedAt: ts }).where(eq(schema.documents.id, id)).run();
}

test('recentFiles：按 updated_at DESC 全局排序（跨目录）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', ['r1']);
    const b = await uploadDocument(ownerId, 'b.md', 'y', ['r2']);
    const c = await uploadDocument(ownerId, 'c.md', 'z', []);
    const T = 1_700_000_000_000;
    setUpdatedAt(a.id, T);
    setUpdatedAt(b.id, T + 10);
    setUpdatedAt(c.id, T + 5);
    const rows = recentFiles(ownerId, 'updated', null, 50);
    expect(rows.map((r) => r.name)).toEqual(['b.md', 'c.md', 'a.md']);
});

test('recentFiles：仅文件，不含文件夹', async () => {
    await uploadDocument(ownerId, 'f.md', 'x', ['fold']); // 会顺带建 folder 'fold'
    const rows = recentFiles(ownerId, 'updated', null, 50);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.type === 'file')).toBe(true);
});

test('recentFiles：cursor 排除自身与更新行（keyset）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setUpdatedAt(a.id, T);
    setUpdatedAt(b.id, T - 10);
    const page1 = recentFiles(ownerId, 'updated', null, 1);
    expect(page1.map((r) => r.name)).toEqual(['a.md']);
    const page2 = recentFiles(ownerId, 'updated', { ts: page1[0].updatedAt, id: page1[0].id }, 50);
    expect(page2.map((r) => r.name)).toEqual(['b.md']);
});

test('recentFiles：同 updated_at 按 id DESC 决胜（keyset 全序）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setUpdatedAt(a.id, T);
    setUpdatedAt(b.id, T);
    const rows = recentFiles(ownerId, 'updated', null, 50);
    const idDesc = [a.id, b.id].sort().reverse().join(',');
    expect(rows.map((r) => r.id).join(',')).toBe(idDesc);
});

test('recentFiles：owner 隔离', async () => {
    const other = generateId();
    db.insert(schema.users).values({
        id: other, email: `t2-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    await uploadDocument(ownerId, 'mine.md', 'x', []);
    await uploadDocument(other, 'theirs.md', 'y', []);
    const rows = recentFiles(ownerId, 'updated', null, 50);
    expect(rows.map((r) => r.name)).toEqual(['mine.md']);
});

test('recentFiles：limit 生效', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', []);
    await uploadDocument(ownerId, 'b.md', 'y', []);
    expect(recentFiles(ownerId, 'updated', null, 1).length).toBe(1);
});

// ===== markOwnerViewed + recentFiles sort=viewed（「最近浏览」spec §5.3/§5.4） =====

function setOwnerViewedAt(id: string, ts: number | null): void {
    db.update(schema.documents).set({ ownerViewedAt: ts }).where(eq(schema.documents.id, id)).run();
}

test('markOwnerViewed：命中且只写 owner_viewed_at（updated_at/last_viewed_at 不动）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    setUpdatedAt(a.id, 1_700_000_000_000);
    const before = Date.now();
    expect(markOwnerViewed(ownerId, a.id)).toBe(true);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, a.id)).get()!;
    expect(row.ownerViewedAt).toBeGreaterThanOrEqual(before);
    expect(row.updatedAt).toBe(1_700_000_000_000);
    expect(row.lastViewedAt).toBeNull();
});

test('markOwnerViewed：非本人 / folder / 不存在 → false', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', ['fold']); // 顺带建 folder 'fold'
    const other = generateId();
    db.insert(schema.users).values({
        id: other, email: `mv-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    expect(markOwnerViewed(other, a.id)).toBe(false);
    const folder = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.type, 'folder'))).get()!;
    expect(markOwnerViewed(ownerId, folder.id)).toBe(false);
    expect(markOwnerViewed(ownerId, 'nonexistent')).toBe(false);
});

test('recentFiles sort=viewed：按 owner_viewed_at DESC，未浏览不出现', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    await uploadDocument(ownerId, 'c.md', 'z', []); // 从未浏览
    const T = 1_700_000_000_000;
    setOwnerViewedAt(a.id, T);
    setOwnerViewedAt(b.id, T + 10);
    const rows = recentFiles(ownerId, 'viewed', null, 50);
    expect(rows.map((r) => r.name)).toEqual(['b.md', 'a.md']);
});

test('recentFiles sort=viewed：cursor keyset 排除自身与更旧行', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setOwnerViewedAt(a.id, T);
    setOwnerViewedAt(b.id, T - 10);
    const page1 = recentFiles(ownerId, 'viewed', null, 1);
    expect(page1.map((r) => r.name)).toEqual(['a.md']);
    const page2 = recentFiles(ownerId, 'viewed', { ts: page1[0].ownerViewedAt!, id: page1[0].id }, 50);
    expect(page2.map((r) => r.name)).toEqual(['b.md']);
});

test('recentFiles sort=viewed：owner 隔离', async () => {
    const other = generateId();
    db.insert(schema.users).values({
        id: other, email: `vv-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    await uploadDocument(ownerId, 'mine.md', 'x', []);
    const theirs = await uploadDocument(other, 'theirs.md', 'y', []);
    setOwnerViewedAt(theirs.id, 1_700_000_000_000);
    expect(recentFiles(ownerId, 'viewed', null, 50)).toEqual([]);
});

test('recentFiles sort=viewed：仅文件，排除手工置了 owner_viewed_at 的 folder（纵深防御）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', ['fold']); // 顺带建 folder 'fold'
    const folder = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.type, 'folder'))).get()!;
    const T = 1_700_000_000_000;
    setOwnerViewedAt(a.id, T);
    setOwnerViewedAt(folder.id, T + 1); // 生产路径 folder 不可能拿到该值；手工置上仍不应入序
    const rows = recentFiles(ownerId, 'viewed', null, 50);
    expect(rows.map((r) => r.name)).toEqual(['a.md']);
});

// ===== P1-1：并发首次上传同位置 =====

test('并发首次上传同位置：唯一索引拦截 + 冲突重试 → 单行、双方同 id（P1-1 回归）', async () => {
    const [a, b] = await Promise.all([
        uploadDocument(ownerId, 'race.md', 'content-A', []),
        uploadDocument(ownerId, 'race.md', 'content-B', [])
    ]);
    const rows = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.name, 'race.md'))).all();
    expect(rows.length).toBe(1);
    expect(a.id).toBe(rows[0].id);
    expect(b.id).toBe(rows[0].id);
    // 谁最后落盘不确定，但行内容、DB hash、磁盘文件三者必须一致
    const final = await readFile(rows[0].storagePath!);
    expect(['content-A', 'content-B']).toContain(final);
    expect(rows[0].contentHash).toBe(sha256Hex(final));
});

// ===== P1-4：跨类型同名冲突 =====

test('上传文件名撞同名 folder（盘上实体目录）→ NameConflictError 而非 EISDIR 500（P1-4 回归）', async () => {
    await uploadDocument(ownerId, 'inner.md', 'x', ['reports']);
    await expect(uploadDocument(ownerId, 'reports', 'y', [])).rejects.toBeInstanceOf(NameConflictError);
});

test('路径段被同名 file 占位（陷阱目录）→ NameConflictError 而非 EEXIST 500（P1-4 回归）', async () => {
    await uploadDocument(ownerId, 'q2.md', 'x', []);
    const now = Date.now();
    db.insert(schema.documents).values({
        id: 'trapfold', ownerId, parentId: null, name: 'q2.md', type: 'folder',
        storagePath: null, contentHash: null, sizeBytes: null, createdAt: now, updatedAt: now
    }).run();
    await expect(uploadDocument(ownerId, 'child.md', 'y', ['q2.md'])).rejects.toBeInstanceOf(NameConflictError);
});

// ===== P2-3：覆盖上传写窗口内的同步交错 =====

test('覆盖上传写窗口内 deleteNode → 干净重建而非孤儿 FTS/FK 500（P2-3 回归）', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'v1', []);
    const up = uploadDocument(ownerId, 'a.md', 'v2', []);
    // uploadDocument 到 writeFile 之间只有微任务——setImmediate 必落其窗口内
    await new Promise((res) => setImmediate(res));
    deleteNode(ownerId, r.id);
    const r2 = await up;
    const rows = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.name, 'a.md'))).all();
    expect(rows.length).toBe(1);
    expect(rows[0].id).toBe(r2.id);
    expect((sqlite.prepare('SELECT COUNT(*) AS c FROM docs_fts').get() as { c: number }).c).toBe(1);
});

test('覆盖上传写窗口内 renameNode → 走全新插入，两行各得其所（P2-3 回归）', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'v1', []);
    const up = uploadDocument(ownerId, 'a.md', 'v2', []);
    await new Promise((res) => setImmediate(res));
    expect(renameNode(ownerId, r.id, 'renamed.md').ok).toBe(true);
    await up;
    const renamed = db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()!;
    const fresh = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.name, 'a.md'))).get()!;
    expect(renamed.name).toBe('renamed.md');
    expect(await readFile(renamed.storagePath!)).toBe('v1');
    expect(fresh.id).not.toBe(r.id);
    expect(await readFile(fresh.storagePath!)).toBe('v2');
});

test('move 后覆盖上传清理旧位置物理文件（备忘：正常流程不留孤儿）', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'v1', []);
    const target = await uploadDocument(ownerId, 'b.md', 'x', ['fold']);
    const foldRow = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.type, 'folder'))).get()!;
    expect(moveNode(ownerId, r.id, foldRow.id).ok).toBe(true);
    const oldPath = db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()!.storagePath!;
    await uploadDocument(ownerId, 'a.md', 'v2', ['fold']);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()!;
    expect(await readFile(row.storagePath!)).toBe('v2');
    await expect(readFile(oldPath)).rejects.toMatchObject({ code: 'FILE_NOT_FOUND' });
});
