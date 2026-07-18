import { test, expect, beforeAll, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, schema } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import {
    generateShareToken,
    createShareLink,
    getDocumentIdByShareToken
} from '../src/lib/server/shares';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '../src/lib/server/db/migrations');

let docId: string;

beforeAll(() => {
    migrate(db, { migrationsFolder });
});

beforeEach(() => {
    db.delete(schema.shareLinks).run();
    db.delete(schema.documents).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.users).run();
    const userId = generateId();
    db.insert(schema.users).values({
        id: userId,
        email: `s-${Date.now()}@x.com`,
        passwordHash: 'x',
        role: 'member',
        createdAt: Date.now()
    }).run();
    docId = generateId();
    db.insert(schema.documents).values({
        id: docId,
        ownerId: userId,
        parentId: null,
        name: 'd.md',
        type: 'file',
        storagePath: '/tmp/d.md',
        contentHash: 'h',
        sizeBytes: 1,
        createdAt: Date.now(),
        updatedAt: Date.now()
    }).run();
});

test('生成非空 token', () => {
    expect(generateShareToken()).toBeTruthy();
});

test('两次生成不同', () => {
    expect(generateShareToken()).not.toBe(generateShareToken());
});

test('长度足够（≥20 字符，128bit 熵）', () => {
    expect(generateShareToken().length).toBeGreaterThanOrEqual(20);
});

test('字符集安全（base64url）', () => {
    expect(generateShareToken()).toMatch(/^[A-Za-z0-9_-]+$/);
});

test('createShareLink 返回 token+url，可反查 documentId', async () => {
    const { token, url } = await createShareLink(docId);
    expect(url).toMatch(/\/s\//);
    expect(getDocumentIdByShareToken(token)).toBe(docId);
});

test('无效 token → null', () => {
    expect(getDocumentIdByShareToken('nonexistent-token')).toBeNull();
});

test('永久 share link（expiresAt=null）可访问', async () => {
    const { token } = await createShareLink(docId);
    expect(getDocumentIdByShareToken(token)).toBe(docId);
});

test('过期 share link（expiresAt 在过去）→ null', () => {
    const token = generateShareToken();
    db.insert(schema.shareLinks).values({
        id: generateId(),
        documentId: docId,
        token,
        expiresAt: Date.now() - 1000,
        createdAt: Date.now()
    }).run();
    expect(getDocumentIdByShareToken(token)).toBeNull();
});
