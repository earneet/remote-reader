import { test, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/server/db';
import { generateId, hashPassword, hashToken } from '../src/lib/server/auth';
import { listTokens, createTokenForUser, revokeToken } from '../src/lib/server/apitokens';

let userId: string;

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
});

test('createTokenForUser 落库并返回明文一次', async () => {
    const { id, plaintext } = await createTokenForUser(userId, 'my-agent');
    expect(id).toBeTruthy();
    expect(plaintext).toMatch(/^rr_/);
    const row = db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, id)).get();
    expect(row?.name).toBe('my-agent');
    expect(row?.tokenHash).toBe(hashToken(plaintext));
    expect(row?.userId).toBe(userId);
});

test('listTokens 返回 owner 的 token（不含 hash）', async () => {
    await createTokenForUser(userId, 'a');
    await createTokenForUser(userId, 'b');
    const list = listTokens(userId);
    expect(list.length).toBe(2);
    expect(list[0]).not.toHaveProperty('tokenHash');
});

test('listTokens 不返回他人的 token', async () => {
    await createTokenForUser(userId, 'a');
    expect(listTokens('other-user').length).toBe(0);
});

test('revokeToken 删除指定 token', async () => {
    const { id } = await createTokenForUser(userId, 'a');
    expect(revokeToken(userId, id)).toBe(true);
    expect(db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, id)).get()).toBeUndefined();
});

test('revokeToken 非 owner 返回 false', async () => {
    const { id } = await createTokenForUser(userId, 'a');
    expect(revokeToken('other-user', id)).toBe(false);
});
