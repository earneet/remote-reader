import { test, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { listTags, listTagsForDoc, listTagsForDocs, setDocTags, SetTagsError, renameTag, deleteTag } from '../src/lib/server/tags';

let ownerId: string;
let docId: string;
const now = () => Date.now();

beforeEach(() => {
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    docId = generateId();
    db.insert(schema.users).values(
        { id: ownerId, email: `t-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: now() }
    ).run();
    db.insert(schema.documents).values({
        id: docId, ownerId, parentId: null, name: 'a.md', type: 'file',
        storagePath: '/tmp/a', contentHash: 'h', sizeBytes: 1, createdAt: now(), updatedAt: now()
    }).run();
});

function mkTag(name: string) {
    const id = generateId();
    db.insert(schema.tags).values({ id, ownerId, name, createdAt: now() }).run();
    db.insert(schema.documentTags).values({ tagId: id, documentId: docId }).run();
    return id;
}

test('listTags 返回 owner 全部标签（带 docCount，按名排序）', () => {
    mkTag('周报'); mkTag('api');
    const r = listTags(ownerId);
    expect(r.map(t => t.name)).toEqual(['api', '周报']);
    expect(r[0].docCount).toBe(1);
});

test('listTags 不返回其他 owner 的标签', () => {
    mkTag('mine');
    const other = generateId();
    db.insert(schema.users).values(
        { id: other, email: `o-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: now() }
    ).run();
    db.insert(schema.tags).values({ id: generateId(), ownerId: other, name: 'theirs', createdAt: now() }).run();
    expect(listTags(ownerId).map(t => t.name)).toEqual(['mine']);
});

test('listTagsForDoc 返回文档标签', () => {
    mkTag('x'); mkTag('y');
    expect(listTagsForDoc(docId, ownerId).map(t => t.name).sort()).toEqual(['x', 'y']);
});

test('listTagsForDocs 批量返回映射', () => {
    const doc2 = generateId();
    db.insert(schema.documents).values({
        id: doc2, ownerId, parentId: null, name: 'b.md', type: 'file',
        storagePath: '/tmp/b', contentHash: 'h', sizeBytes: 1, createdAt: now(), updatedAt: now()
    }).run();
    const sharedId = mkTag('shared');
    db.insert(schema.documentTags).values({ tagId: sharedId, documentId: doc2 }).run();
    const t2id = generateId();
    db.insert(schema.tags).values({ id: t2id, ownerId, name: 'only-b', createdAt: now() }).run();
    db.insert(schema.documentTags).values({ tagId: t2id, documentId: doc2 }).run();
    const map = listTagsForDocs([docId, doc2], ownerId);
    expect(map.get(docId)!.map(t => t.name)).toEqual(['shared']);
    expect(map.get(doc2)!.map(t => t.name).sort()).toEqual(['only-b', 'shared']);
});

test('setDocTags 新增不存在的标签并建立关联', () => {
    setDocTags(ownerId, docId, ['周报', 'api']);
    expect(listTagsForDoc(docId, ownerId).map(t => t.name).sort()).toEqual(['api', '周报']);
    expect(listTags(ownerId).length).toBe(2);
});

test('setDocTags 复用已存在的同名标签（不重复建 tag 行）', () => {
    setDocTags(ownerId, docId, ['x']);
    const doc2 = generateId();
    db.insert(schema.documents).values({
        id: doc2, ownerId, parentId: null, name: 'b.md', type: 'file',
        storagePath: '/tmp/b', contentHash: 'h', sizeBytes: 1, createdAt: now(), updatedAt: now()
    }).run();
    setDocTags(ownerId, doc2, ['x', 'y']);
    expect(listTags(ownerId).length).toBe(2);
    expect(listTagsForDoc(doc2, ownerId).map(t => t.name).sort()).toEqual(['x', 'y']);
});

test('setDocTags 移除不再列出的关联', () => {
    setDocTags(ownerId, docId, ['a', 'b']);
    setDocTags(ownerId, docId, ['a']);
    expect(listTagsForDoc(docId, ownerId).map(t => t.name)).toEqual(['a']);
});

test('setDocTags 传空数组移除全部关联（标签本身保留）', () => {
    setDocTags(ownerId, docId, ['a']);
    setDocTags(ownerId, docId, []);
    expect(listTagsForDoc(docId, ownerId)).toEqual([]);
    expect(listTags(ownerId).map(t => t.name)).toEqual(['a']);
});

test('setDocTags 去重 + 静默丢弃非法名', () => {
    setDocTags(ownerId, docId, ['ok', 'ok', '  ', 'a/b', 'ok']);
    expect(listTagsForDoc(docId, ownerId).map(t => t.name)).toEqual(['ok']);
});

test('setDocTags 非 owner 文档抛 not_found', () => {
    try {
        setDocTags('other', docId, ['x']);
        throw new Error('should have thrown');
    } catch (e) {
        expect(e).toBeInstanceOf(SetTagsError);
        expect((e as SetTagsError).code).toBe('not_found');
    }
});

test('setDocTags 文件夹抛 not_found（仅 file 可打标签）', () => {
    const folderId = generateId();
    db.insert(schema.documents).values({
        id: folderId, ownerId, parentId: null, name: 'fold', type: 'folder',
        storagePath: null, contentHash: null, sizeBytes: null, createdAt: now(), updatedAt: now()
    }).run();
    try {
        setDocTags(ownerId, folderId, ['x']);
        throw new Error('should have thrown');
    } catch (e) {
        expect(e).toBeInstanceOf(SetTagsError);
        expect((e as SetTagsError).code).toBe('not_found');
    }
});

test('renameTag 改名影响所有关联文档', () => {
    setDocTags(ownerId, docId, ['old']);
    expect(renameTag(ownerId, 'old', 'new').ok).toBe(true);
    expect(listTagsForDoc(docId, ownerId).map(t => t.name)).toEqual(['new']);
});

test('renameTag 目标名已存在返回 conflict', () => {
    setDocTags(ownerId, docId, ['a', 'b']);
    const r = renameTag(ownerId, 'a', 'b');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('conflict');
});

test('renameTag 非法新名返回 invalid', () => {
    setDocTags(ownerId, docId, ['a']);
    expect(renameTag(ownerId, 'a', 'x/y').code).toBe('invalid');
});

test('renameTag 不存在的标签返回 not_found', () => {
    expect(renameTag(ownerId, 'nope', 'x').code).toBe('not_found');
});

test('deleteTag 删 tag 并级联清关联', () => {
    setDocTags(ownerId, docId, ['a', 'b']);
    deleteTag(ownerId, 'a');
    expect(listTagsForDoc(docId, ownerId).map(t => t.name)).toEqual(['b']);
    expect(listTags(ownerId).map(t => t.name)).toEqual(['b']);
});

test('deleteTag 其他 owner 的同名标签不受影响', () => {
    setDocTags(ownerId, docId, ['shared']);
    const other = generateId();
    db.insert(schema.users).values(
        { id: other, email: `o-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: now() }
    ).run();
    db.insert(schema.tags).values({ id: generateId(), ownerId: other, name: 'shared', createdAt: now() }).run();
    deleteTag(ownerId, 'shared');
    expect(listTags(ownerId).length).toBe(0);
    expect(db.select().from(schema.tags).where(eq(schema.tags.ownerId, other)).all().length).toBe(1);
});
