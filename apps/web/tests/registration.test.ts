import { test, expect, beforeEach } from 'vitest';
import { db, schema } from '../src/lib/server/db';
import { eq } from 'drizzle-orm';
import { createInviteCode } from '../src/lib/server/invites';

import { resetDb } from './helpers';
process.env.INITIAL_INVITE_CODE = 'testinvite';
const { registerUser, authenticateUser } = await import('../src/lib/server/registration');

beforeEach(() => resetDb());

test('registerUser 成功（bootstrap 码）→ 首个用户 admin，邮箱归一化', async () => {
    const r = await registerUser({ email: 'A@X.com ', password: 'password123', inviteCode: 'testinvite' });
    expect(r.ok).toBe(true);
    const users = db.select().from(schema.users).all();
    expect(users).toHaveLength(1);
    expect(users[0].email).toBe('a@x.com');
    expect(users[0].role).toBe('admin');
});

test('registerUser 成功（DB 码）→ 核销计数 +1，第二用户 member', async () => {
    const first = await registerUser({ email: 'a@x.com', password: 'password123', inviteCode: 'testinvite' });
    if (!first.ok) throw new Error('setup failed');
    const inv = await createInviteCode(first.userId, 'test', 7);
    const r = await registerUser({ email: 'b@x.com', password: 'password123', inviteCode: inv.plaintext });
    expect(r.ok).toBe(true);
    const row = db.select().from(schema.inviteCodes).where(eq(schema.inviteCodes.id, inv.id)).get();
    expect(row?.usedCount).toBe(1);
    expect(db.select().from(schema.users).all().find((u) => u.email === 'b@x.com')?.role).toBe('member');
});

test('registerUser 400：缺字段 / 邮箱格式 / 密码过短', async () => {
    expect(await registerUser({ email: '', password: 'password123', inviteCode: 'testinvite' }))
        .toMatchObject({ ok: false, status: 400 });
    expect(await registerUser({ email: 'not-an-email', password: 'password123', inviteCode: 'testinvite' }))
        .toMatchObject({ ok: false, status: 400 });
    expect(await registerUser({ email: 'a@x.com', password: '1234567', inviteCode: 'testinvite' }))
        .toMatchObject({ ok: false, status: 400 });
});

test('registerUser 403：邀请码无效', async () => {
    expect(await registerUser({ email: 'a@x.com', password: 'password123', inviteCode: 'wrong' }))
        .toMatchObject({ ok: false, status: 403 });
});

test('registerUser 409：邮箱已注册，且 DB 码不烧核销计数', async () => {
    const first = await registerUser({ email: 'a@x.com', password: 'password123', inviteCode: 'testinvite' });
    if (!first.ok) throw new Error('setup failed');
    const inv = await createInviteCode(first.userId, 'test', 7);
    const r = await registerUser({ email: 'a@x.com', password: 'password123', inviteCode: inv.plaintext });
    expect(r).toMatchObject({ ok: false, status: 409 });
    const row = db.select().from(schema.inviteCodes).where(eq(schema.inviteCodes.id, inv.id)).get();
    expect(row?.usedCount).toBe(0);
});

test('authenticateUser：成功 / 密码错 / 用户不存在', async () => {
    const reg = await registerUser({ email: 'a@x.com', password: 'password123', inviteCode: 'testinvite' });
    if (!reg.ok) throw new Error('setup failed');
    expect((await authenticateUser('a@x.com', 'password123'))?.id).toBe(reg.userId);
    expect(await authenticateUser('a@x.com', 'wrong-password')).toBeNull();
    expect(await authenticateUser('ghost@x.com', 'password123')).toBeNull();
});
