import { test, expect, beforeEach } from 'vitest';
import { db, schema, sqlite } from '../src/lib/server/db';
import { eq } from 'drizzle-orm';
import { hashPassword, generateId } from '../src/lib/server/auth';

// P2-6：IP 聚合桶须小上限才可测——须在 import 路由模块前设
process.env.LOGIN_IP_RATE_LIMIT_MAX = '3';
process.env.LOGIN_RATE_LIMIT_MAX = '10000';
const loginMod = await import('../src/routes/login/+page.server');

beforeEach(async () => {
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.documents).run();
    db.delete(schema.inviteCodes).run();
    db.delete(schema.users).run();
    db.insert(schema.users).values({
        id: generateId(), email: 'u@x.com', passwordHash: await hashPassword('right-password'),
        role: 'member', createdAt: Date.now()
    }).run();
});

async function tryLogin(email: string, address: string, password = 'wrong-password'): Promise<number> {
    const fd = new FormData();
    fd.set('email', email);
    fd.set('password', password);
    try {
        const r = await loginMod.actions.default({
            request: new Request('http://localhost/x', { method: 'POST', body: fd }),
            cookies: { set() {}, get: () => undefined, delete() {} },
            getClientAddress: () => address
        } as unknown as Parameters<typeof loginMod.actions.default>[0]);
        return (r as { status?: number })?.status ?? 200;
    } catch (e) {
        return (e as { status?: number })?.status ?? 500;
    }
}

test('密码喷洒：同 IP 每次换邮箱也触聚合限流 429（P2-6）', async () => {
    const ip = 'spray-9.9.9.9';
    expect(await tryLogin('a1@x.com', ip)).toBe(401);
    expect(await tryLogin('a2@x.com', ip)).toBe(401);
    expect(await tryLogin('a3@x.com', ip)).toBe(401);
    expect(await tryLogin('a4@x.com', ip)).toBe(429);
});

test('精确桶不受影响：其他 IP 正常登录不受单 IP 触限牵连', async () => {
    const ip = 'spray-8.8.8.8';
    for (let i = 0; i < 3; i++) await tryLogin(`b${i}@x.com`, ip);
    expect(await tryLogin('c@x.com', ip)).toBe(429);
    expect(await tryLogin('u@x.com', 'other-1.1.1.1', 'right-password')).toBe(302);
});
