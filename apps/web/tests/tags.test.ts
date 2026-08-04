import { test, expect, beforeEach } from 'vitest';
import { db, schema } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { listTags, listTagsForDoc, listTagsForDocs } from '../src/lib/server/tags';

let ownerId: string;
let docId: string;
const now = () => Date.now();

beforeEach(() => {
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
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
