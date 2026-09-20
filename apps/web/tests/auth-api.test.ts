import { test, expect, beforeEach } from 'vitest';
import { db, schema } from '../src/lib/server/db';
import { eq } from 'drizzle-orm';
import { hashToken } from '../src/lib/server/auth';
import { createInviteCode } from '../src/lib/server/invites';

// 放宽限流避免用例间互相触发；429 语义见 auth-api-ratelimit.test.ts
import { resetDb } from './helpers';
process.env.REGISTER_RATE_LIMIT_MAX = '10000';
process.env.LOGIN_RATE_LIMIT_MAX = '10000';
process.env.LOGIN_IP_RATE_LIMIT_MAX = '10000';
process.env.INITIAL_INVITE_CODE = 'testinvite';
// 本任务先只导入 register；loginPOST/tokenPOST 分别在 Task 4/5 追加（避免缺失模块阻塞本任务测试）
const { POST: registerPOST } = await import('../src/routes/api/v1/auth/register/+server');
const { POST: loginPOST } = await import('../src/routes/api/v1/auth/login/+server');
const { POST: tokenPOST } = await import('../src/routes/api/v1/auth/api-token/+server');

beforeEach(() => resetDb());

function mockCookies() {
    const store: Record<string, string> = {};
    return {
        set: (n: string, v: string) => { store[n] = v; },
        get: (n: string) => store[n],
        delete: (n: string) => { delete store[n]; },
        _store: store
    };
}

function makeEvent(body: unknown, opts: { address?: string; userId?: string } = {}) {
    const request = new Request('http://localhost/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
    return {
        request,
        cookies: mockCookies(),
        locals: { user: opts.userId ? { id: opts.userId } : null },
        getClientAddress: () => opts.address ?? `ip-${Math.random()}`
    } as any;
}

async function call(fn: (evt: any) => Response | Promise<Response>, body: unknown, opts: { address?: string; userId?: string } = {}) {
    const evt = makeEvent(body, opts);
    try {
        const r = await fn(evt);
        return { status: r.status, body: await r.json().catch(() => null), cookies: evt.cookies };
    } catch (e) {
        return { status: (e as { status?: number })?.status ?? 500, body: (e as { body?: unknown })?.body ?? null, cookies: evt.cookies };
    }
}

// ── register ──

test('register 成功（bootstrap 码）→ 200 + session cookie + 用户入库', async () => {
    const r = await call(registerPOST, { email: 'a@x.com', password: 'password123', invite_code: 'testinvite' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(r.cookies._store.session).toBeTruthy();
    expect(db.select().from(schema.users).all()).toHaveLength(1);
});

test('register 成功（DB 码）→ 核销 used_count+1', async () => {
    await call(registerPOST, { email: 'a@x.com', password: 'password123', invite_code: 'testinvite' });
    const admin = db.select().from(schema.users).all()[0];
    const inv = await createInviteCode(admin.id, 'test', 7);
    const r = await call(registerPOST, { email: 'b@x.com', password: 'password123', invite_code: inv.plaintext });
    expect(r.status).toBe(200);
    const row = db.select().from(schema.inviteCodes).where(eq(schema.inviteCodes.id, inv.id)).get();
    expect(row?.usedCount).toBe(1);
});

test('register 400：缺 password', async () => {
    const r = await call(registerPOST, { email: 'a@x.com', invite_code: 'testinvite' });
    expect(r.status).toBe(400);
    expect((r.body as { message?: string }).message).toBeTruthy();
});

test('register 403：邀请码无效', async () => {
    const r = await call(registerPOST, { email: 'a@x.com', password: 'password123', invite_code: 'bad' });
    expect(r.status).toBe(403);
});

test('register 409：邮箱已注册', async () => {
    await call(registerPOST, { email: 'a@x.com', password: 'password123', invite_code: 'testinvite' });
    const r = await call(registerPOST, { email: 'a@x.com', password: 'password123', invite_code: 'testinvite' });
    expect(r.status).toBe(409);
});

test('register 400：非法 JSON body', async () => {
    const evt = makeEvent(null);
    evt.request = new Request('http://localhost/api', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{broken'
    });
    try {
        await registerPOST(evt);
        expect.unreachable('应抛 400');
    } catch (e) {
        expect((e as { status?: number }).status).toBe(400);
    }
});

// ── login ──

async function seedUser(email = 'a@x.com', password = 'password123') {
    await call(registerPOST, { email, password, invite_code: 'testinvite' });
}

test('login 成功 → 200 + session cookie', async () => {
    await seedUser();
    const r = await call(loginPOST, { email: 'a@x.com', password: 'password123' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ ok: true });
    expect(r.cookies._store.session).toBeTruthy();
});

test('login 401：密码错与用户不存在响应一致（防邮箱枚举）', async () => {
    await seedUser();
    const wrong = await call(loginPOST, { email: 'a@x.com', password: 'wrong-password' });
    const ghost = await call(loginPOST, { email: 'ghost@x.com', password: 'password123' });
    expect(wrong.status).toBe(401);
    expect(ghost.status).toBe(401);
    expect(wrong.body).toEqual(ghost.body);
});

test('login 400：缺 email', async () => {
    const r = await call(loginPOST, { password: 'password123' });
    expect(r.status).toBe(400);
});

// ── api-token ──

test('api-token 成功 → 200 + rr_ 明文 + 哈希入库', async () => {
    await seedUser();
    const user = db.select().from(schema.users).where(eq(schema.users.email, 'a@x.com')).get();
    if (!user) throw new Error('setup failed');
    const r = await call(tokenPOST, { name: 'my-agent' }, { userId: user.id });
    expect(r.status).toBe(200);
    const token = (r.body as { token?: string }).token;
    expect(token).toMatch(/^rr_/);
    const row = db.select().from(schema.apiTokens)
        .where(eq(schema.apiTokens.tokenHash, hashToken(token!))).get();
    expect(row?.name).toBe('my-agent');
    expect(row?.userId).toBe(user.id);
});

test('api-token 401：无 session', async () => {
    const r = await call(tokenPOST, { name: 'x' });
    expect(r.status).toBe(401);
});

test('api-token 400：空 name / 缺 name', async () => {
    const r1 = await call(tokenPOST, { name: '  ' }, { userId: 'u1' });
    expect(r1.status).toBe(400);
    const r2 = await call(tokenPOST, {}, { userId: 'u1' });
    expect(r2.status).toBe(400);
});

test('api-token 400：name 超长（>100 字符）', async () => {
    const r = await call(tokenPOST, { name: 'x'.repeat(101) }, { userId: 'u1' });
    expect(r.status).toBe(400);
});

// ── 登录页指引块数据 ──

test('login load 返回 baseUrl/repoUrl（agent-guide SSR 注入）', async () => {
    // vitest 下 Vite 注入 process.env.BASE_URL='/'（归一化成 ''）——显式设值使断言密闭
    const prev = process.env.BASE_URL;
    process.env.BASE_URL = 'https://guide.example.com';
    try {
        const { load } = await import('../src/routes/login/+page.server');
        const data = await load({ locals: { user: null } } as any);
        expect(data?.baseUrl).toBe('https://guide.example.com');
        expect(data?.repoUrl).toContain('github.com');
    } finally {
        if (prev === undefined) delete process.env.BASE_URL;
        else process.env.BASE_URL = prev;
    }
});
