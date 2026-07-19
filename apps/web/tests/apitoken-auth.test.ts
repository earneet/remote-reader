import { test, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/server/db';
import { generateApiToken, generateId, hashPassword } from '../src/lib/server/auth';
import { authenticateApiToken } from '../src/lib/server/apitoken-auth';

let plaintext: string;
let userId: string;
let tokenId: string;

beforeEach(async () => {
    db.delete(schema.apiTokens).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    userId = generateId();
    db.insert(schema.users).values({
        id: userId,
        email: `t-${Date.now()}@x.com`,
        passwordHash: await hashPassword('x'),
        role: 'member',
        createdAt: Date.now()
    }).run();
    const t = await generateApiToken();
    tokenId = generateId();
    db.insert(schema.apiTokens).values({
        id: tokenId,
        userId,
        name: 'test',
        tokenHash: t.hash,
        lastUsedAt: null,
        createdAt: Date.now()
    }).run();
    plaintext = t.plaintext;
});

test('null header → null', () => {
    expect(authenticateApiToken(null)).toBeNull();
});

test('非 Bearer 前缀 → null', () => {
    expect(authenticateApiToken('Basic abcdef')).toBeNull();
    expect(authenticateApiToken(plaintext)).toBeNull();
    expect(authenticateApiToken('Bearer')).toBeNull();
});

test('错误 token → null', () => {
    expect(authenticateApiToken('Bearer rr_bogus_xyz')).toBeNull();
});

test('正确 token → 返回 {userId, tokenId}', () => {
    expect(authenticateApiToken(`Bearer ${plaintext}`)).toEqual({ userId, tokenId });
});

test('成功认证后更新 last_used_at', () => {
    const before = db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, tokenId)).get();
    expect(before?.lastUsedAt).toBeNull();
    authenticateApiToken(`Bearer ${plaintext}`);
    const after = db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, tokenId)).get();
    expect(after?.lastUsedAt).not.toBeNull();
});
