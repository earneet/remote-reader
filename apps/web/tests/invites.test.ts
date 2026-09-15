import { test, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId, hashPassword, hashToken } from '../src/lib/server/auth';
import { listInvites, createInviteCode, revokeInvite, redeemInviteCode, isInviteCodeValid } from '../src/lib/server/invites';

import { resetDb } from './helpers';
let adminId: string;

beforeEach(async () => {
    // 与 settings.test.ts 相同的清表顺序（FK 依赖从叶到根）
    resetDb();
    adminId = generateId();
    db.insert(schema.users).values({
        id: adminId,
        email: `a-${Date.now()}@x.com`,
        passwordHash: await hashPassword('x'),
        role: 'admin',
        createdAt: Date.now()
    }).run();
});

test('createInviteCode 落库 hash 并返回 ri_ 明文一次', async () => {
    const { id, plaintext } = await createInviteCode(adminId, '给同事', 7);
    expect(plaintext).toMatch(/^ri_/);
    const row = db.select().from(schema.inviteCodes).where(eq(schema.inviteCodes.id, id)).get();
    expect(row?.codeHash).toBe(hashToken(plaintext));
    expect(row?.createdBy).toBe(adminId);
    expect(row?.note).toBe('给同事');
    expect(row?.expiresAt).toBeGreaterThan(Date.now());
    expect(row?.usedCount).toBe(0);
});

test('listInvites 关联创建者邮箱且不含 codeHash', async () => {
    await createInviteCode(adminId, 'a', 7);
    const list = listInvites();
    expect(list.length).toBe(1);
    expect(list[0].creatorEmail).toContain('@');
    expect(JSON.stringify(list)).not.toContain('codeHash');
});

test('revokeInvite 软撤销（置 revokedAt），重复撤销返回 false', async () => {
    const { id } = await createInviteCode(adminId, 'a', 7);
    expect(revokeInvite(id)).toBe(true);
    const row = db.select().from(schema.inviteCodes).where(eq(schema.inviteCodes.id, id)).get();
    expect(row?.revokedAt).not.toBeNull();
    expect(revokeInvite(id)).toBe(false);
});

test('redeemInviteCode 有效码 → true 且核销 usedCount/lastUsedAt，可多次使用', async () => {
    const { plaintext } = await createInviteCode(adminId, 'a', 7);
    expect(redeemInviteCode(plaintext)).toBe(true);
    const row = db.select().from(schema.inviteCodes).all()[0];
    expect(row.usedCount).toBe(1);
    expect(row.lastUsedAt).not.toBeNull();
    // 有效期内可多次使用（无 max_uses）
    expect(redeemInviteCode(plaintext)).toBe(true);
    expect(db.select().from(schema.inviteCodes).all()[0].usedCount).toBe(2);
});

test('redeemInviteCode 错误码 → false', async () => {
    await createInviteCode(adminId, 'a', 7);
    expect(redeemInviteCode('ri_nope')).toBe(false);
});

test('redeemInviteCode 已过期 → false 且不核销', async () => {
    const { plaintext } = await createInviteCode(adminId, 'a', 1);
    db.update(schema.inviteCodes).set({ expiresAt: Date.now() - 1 }).run();
    expect(redeemInviteCode(plaintext)).toBe(false);
    expect(db.select().from(schema.inviteCodes).all()[0].usedCount).toBe(0);
});

test('redeemInviteCode 已撤销 → false 且不核销', async () => {
    const { id, plaintext } = await createInviteCode(adminId, 'a', 7);
    revokeInvite(id);
    expect(redeemInviteCode(plaintext)).toBe(false);
    expect(db.select().from(schema.inviteCodes).all()[0].usedCount).toBe(0);
});

test('isInviteCodeValid 预检不核销（P2-5）', async () => {
    const admin = db.select().from(schema.users).all()[0];
    const { plaintext } = await createInviteCode(admin.id, 'peek', 1);
    expect(isInviteCodeValid(plaintext)).toBe(true);
    expect(isInviteCodeValid(plaintext)).toBe(true);
    expect(db.select().from(schema.inviteCodes).all()[0].usedCount).toBe(0);
});
