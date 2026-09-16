import { test, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import {
    generateShareToken,
    createShareLink,
    getDocumentIdByShareToken,
    listSharesByOwner,
    revokeShare,
    getOrCreateShareUrl,
    revokeAllShares,
    sharedDocIds
} from '../src/lib/server/shares';

import { resetDb } from './helpers';
let docId: string;
let userId: string;

beforeEach(() => {
    resetDb();
    userId = generateId();
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

test('listSharesByOwner 返回 owner 文档的分享（含文档名）', async () => {
    const { token } = await createShareLink(docId);
    const list = listSharesByOwner(userId);
    expect(list.length).toBe(1);
    expect(list[0].token).toBe(token);
    expect(list[0].documentName).toBe('d.md');
});

test('listSharesByOwner 不返回他人文档的分享', async () => {
    await createShareLink(docId);
    expect(listSharesByOwner('other-user').length).toBe(0);
});

test('revokeShare 删除指定 token', async () => {
    const { token } = await createShareLink(docId);
    expect(revokeShare(userId, token)).toBe(true);
    expect(getDocumentIdByShareToken(token)).toBeNull();
});

test('revokeShare 非 owner 返回 false 不删', async () => {
    const { token } = await createShareLink(docId);
    expect(revokeShare('other-user', token)).toBe(false);
    expect(getDocumentIdByShareToken(token)).toBe(docId);
});

// —— spec 2026-09-16 §3.1：分享状态派生 + get-or-create + 批量撤销 ——

function mkUser(): string {
    const id = generateId();
    db.insert(schema.users).values({
        id,
        email: `u-${id}@x.com`,
        passwordHash: 'x',
        role: 'member',
        createdAt: Date.now()
    }).run();
    return id;
}

function mkDoc(owner: string, type: 'file' | 'folder' = 'file'): string {
    const id = generateId();
    db.insert(schema.documents).values({
        id,
        ownerId: owner,
        parentId: null,
        name: `${id}.md`,
        type,
        storagePath: type === 'file' ? '/tmp/x.md' : null,
        contentHash: type === 'file' ? 'h' : null,
        sizeBytes: type === 'file' ? 1 : null,
        createdAt: Date.now(),
        updatedAt: Date.now()
    }).run();
    return id;
}

test('getOrCreateShareUrl：无链接时新建 /s/ URL', async () => {
    const url = await getOrCreateShareUrl(userId, docId);
    expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{20,}$/);
    expect(listSharesByOwner(userId).length).toBe(1);
});

test('getOrCreateShareUrl：已有活跃链接复用同一 URL，不新增行', async () => {
    const first = await getOrCreateShareUrl(userId, docId);
    const second = await getOrCreateShareUrl(userId, docId);
    expect(second).toBe(first);
    expect(listSharesByOwner(userId).length).toBe(1);
});

test('getOrCreateShareUrl：仅有过期链接时新建（旧链接不返回）', async () => {
    const first = await getOrCreateShareUrl(userId, docId);
    expect(first).toBeTruthy();
    const token = first?.split('/s/')[1] ?? '';
    db.update(schema.shareLinks)
        .set({ expiresAt: Date.now() - 1000 })
        .where(eq(schema.shareLinks.token, token)).run();
    const second = await getOrCreateShareUrl(userId, docId);
    expect(second).not.toBe(first);
    expect(listSharesByOwner(userId).length).toBe(2); // 旧过期行仍在表，只是不再返回
});

test('getOrCreateShareUrl：非 owner / 不存在 / folder → null', async () => {
    const other = mkUser();
    const folder = mkDoc(userId, 'folder');
    expect(await getOrCreateShareUrl(other, docId)).toBeNull();
    expect(await getOrCreateShareUrl(userId, 'nope')).toBeNull();
    expect(await getOrCreateShareUrl(userId, folder)).toBeNull();
});

test('revokeAllShares：删除该文档全部链接（多条）并返回删除数', async () => {
    await getOrCreateShareUrl(userId, docId);
    await createShareLink(docId);
    const n = revokeAllShares(userId, docId);
    expect(n).toBe(2);
    expect(sharedDocIds(userId, [docId]).has(docId)).toBe(false);
});

test('revokeAllShares：非 owner → 0 且不删', async () => {
    const other = mkUser();
    await getOrCreateShareUrl(userId, docId);
    expect(revokeAllShares(other, docId)).toBe(0);
    expect(sharedDocIds(userId, [docId]).has(docId)).toBe(true);
});

test('revokeAllShares：无链接幂等 → 0', () => {
    expect(revokeAllShares(userId, docId)).toBe(0);
});

test('sharedDocIds：批量返回有活跃链接的 id，过期不算，空入参空集', async () => {
    const shared = mkDoc(userId);
    const expired = mkDoc(userId);
    const plain = mkDoc(userId);
    await getOrCreateShareUrl(userId, shared);
    const expiredUrl = await getOrCreateShareUrl(userId, expired);
    db.update(schema.shareLinks)
        .set({ expiresAt: Date.now() - 1000 })
        .where(eq(schema.shareLinks.token, expiredUrl?.split('/s/')[1] ?? '')).run();
    const s = sharedDocIds(userId, [shared, expired, plain, docId]);
    expect(s.has(shared)).toBe(true);
    expect(s.has(expired)).toBe(false);
    expect(s.has(plain)).toBe(false);
    expect(sharedDocIds(userId, []).size).toBe(0);
});
