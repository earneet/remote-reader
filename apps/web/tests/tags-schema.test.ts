import { test, expect, beforeEach } from 'vitest';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { eq } from 'drizzle-orm';

let ownerId: string;
beforeEach(() => {
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId, email: `s-${Date.now()}@x.com`, passwordHash: 'x',
        role: 'member', createdAt: Date.now()
    }).run();
});

test('tags 表可写入并按 (owner_id,name) 唯一', () => {
    db.insert(schema.tags).values(
        { id: generateId(), ownerId, name: '周报', createdAt: Date.now() }
    ).run();
    expect(() => db.insert(schema.tags).values(
        { id: generateId(), ownerId, name: '周报', createdAt: Date.now() }
    ).run()).toThrow();
});

test('document_tags ON DELETE cascade：删 tag 自动清关联', () => {
    const tagId = generateId();
    const docId = generateId();
    db.insert(schema.documents).values({
        id: docId, ownerId, parentId: null, name: 'a.md', type: 'file',
        storagePath: '/tmp/x', contentHash: 'h', sizeBytes: 1,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    db.insert(schema.tags).values({ id: tagId, ownerId, name: 't1', createdAt: Date.now() }).run();
    db.insert(schema.documentTags).values({ tagId, documentId: docId }).run();
    expect(db.select().from(schema.documentTags).all().length).toBe(1);
    db.delete(schema.tags).where(eq(schema.tags.id, tagId)).run();
    expect(db.select().from(schema.documentTags).all().length).toBe(0);
});
