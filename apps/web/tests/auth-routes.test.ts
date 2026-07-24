import { test, expect, beforeEach } from 'vitest';
import { db, schema } from '../src/lib/server/db';
import { eq } from 'drizzle-orm';

// 放宽限流、设测试 invite，须在 import 路由模块前
process.env.REGISTER_RATE_LIMIT_MAX = '10000';
process.env.LOGIN_RATE_LIMIT_MAX = '10000';
process.env.INITIAL_INVITE_CODE = 'testinvite';
const registerMod = await import('../src/routes/register/+page.server');
const loginMod = await import('../src/routes/login/+page.server');

beforeEach(() => {
    db.delete(schema.shareLinks).run();
    db.delete(schema.documents).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.users).run();
});

function mockCookies() {
    const store: Record<string, string> = {};
    return {
        set: (n: string, v: string) => {
            store[n] = v;
        },
        get: (n: string) => store[n],
        delete: (n: string) => {
            delete store[n];
        },
        _store: store
    };
}

function formEvent(form: Record<string, string>, address = `ip-${Math.random()}`) {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) fd.append(k, v);
    return {
        request: new Request('http://localhost/x', { method: 'POST', body: fd }),
        cookies: mockCookies(),
        getClientAddress: () => address
    } as any;
}

// action 失败用 return fail(status)（不抛，返回 ActionFailure 带 .status），
// 成功用 redirect(status)（抛 Redirect 带 .status）。统一同时看返回值与抛出。
async function runAction(
    fn: (evt: any) => unknown,
    form: Record<string, string>,
    address = `ip-${Math.random()}`
) {
    const evt = formEvent(form, address);
    try {
        const result = await fn(evt);
        if (result && typeof (result as { status?: number }).status === 'number') {
            return { status: (result as { status: number }).status, cookies: evt.cookies };
        }
        return { status: 200, cookies: evt.cookies };
    } catch (e) {
        return { status: (e as { status?: number })?.status ?? 500, cookies: evt.cookies };
    }
}

function register(form: Record<string, string>, address?: string) {
    return runAction((evt) => registerMod.actions.default(evt), form, address);
}

function login(form: Record<string, string>, address?: string) {
    return runAction((evt) => loginMod.actions.default(evt), form, address);
}

test('register 错 invite → 403', async () => {
    expect((await register({ email: 'a@b.com', password: 'password1', invite_code: 'wrong' })).status).toBe(403);
});

test('register 缺字段 → 400', async () => {
    expect((await register({ email: '', password: '', invite_code: 'testinvite' })).status).toBe(400);
});

test('register 邮箱格式错 → 400', async () => {
    expect((await register({ email: 'not-email', password: 'password1', invite_code: 'testinvite' })).status).toBe(400);
});

test('register 密码短 → 400', async () => {
    expect((await register({ email: 'a@b.com', password: '123', invite_code: 'testinvite' })).status).toBe(400);
});

test('register 首用户为 admin', async () => {
    const r = await register({ email: 'first@b.com', password: 'password1', invite_code: 'testinvite' });
    expect(r.status).toBe(302);
    const u = db.select().from(schema.users).where(eq(schema.users.email, 'first@b.com')).get();
    expect(u?.role).toBe('admin');
});

test('register 第二用户为 member', async () => {
    await register({ email: 'first@b.com', password: 'password1', invite_code: 'testinvite' });
    const r = await register({ email: 'second@b.com', password: 'password1', invite_code: 'testinvite' });
    expect(r.status).toBe(302);
    const u = db.select().from(schema.users).where(eq(schema.users.email, 'second@b.com')).get();
    expect(u?.role).toBe('member');
});

test('register 重复邮箱 → 409', async () => {
    await register({ email: 'dup@b.com', password: 'password1', invite_code: 'testinvite' });
    const r = await register({ email: 'dup@b.com', password: 'password1', invite_code: 'testinvite' });
    expect(r.status).toBe(409);
});

test('login 错密码 → 401', async () => {
    await register({ email: 'u@b.com', password: 'password1', invite_code: 'testinvite' });
    const r = await login({ email: 'u@b.com', password: 'wrong' }, 'lip1');
    expect(r.status).toBe(401);
});

test('login 用户不存在 → 401', async () => {
    const r = await login({ email: 'ghost@b.com', password: 'whatever' }, 'lip2');
    expect(r.status).toBe(401);
});

test('login 成功：设 session cookie 并 redirect 302', async () => {
    await register({ email: 'ok@b.com', password: 'password1', invite_code: 'testinvite' });
    const r = await login({ email: 'ok@b.com', password: 'password1' }, 'lip3');
    expect(r.status).toBe(302);
    expect(r.cookies._store['session']).toBeTruthy();
});
