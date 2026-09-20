import { test, expect, beforeEach } from 'vitest';

// 小限额须在 import 路由前设置（envInt 模块加载时读取）
import { resetDb } from './helpers';
process.env.REGISTER_RATE_LIMIT_MAX = '2';
process.env.LOGIN_RATE_LIMIT_MAX = '2';
process.env.LOGIN_IP_RATE_LIMIT_MAX = '3';
process.env.INITIAL_INVITE_CODE = 'testinvite';
const { POST: registerPOST } = await import('../src/routes/api/v1/auth/register/+server');
const { POST: loginPOST } = await import('../src/routes/api/v1/auth/login/+server');

beforeEach(() => resetDb());

function evt(body: unknown, address: string) {
    return {
        request: new Request('http://localhost/api', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body)
        }),
        cookies: { set: () => {}, get: () => undefined, delete: () => {} },
        locals: { user: null },
        getClientAddress: () => address
    } as any;
}

async function statusOf(fn: (e: any) => Response | Promise<Response>, body: unknown, address: string): Promise<number> {
    try {
        return (await fn(evt(body, address))).status;
    } catch (e) {
        return (e as { status?: number })?.status ?? 500;
    }
}

test('register 同 IP 超限额 → 429', async () => {
    const body = { email: 'a@x.com', password: 'password123', invite_code: 'testinvite' };
    expect(await statusOf(registerPOST, body, 'ip-1')).toBe(200);
    expect(await statusOf(registerPOST, { ...body, email: 'b@x.com' }, 'ip-1')).toBe(200);
    expect(await statusOf(registerPOST, { ...body, email: 'c@x.com' }, 'ip-1')).toBe(429);
});

test('login 精确桶：同 IP 同邮箱超限额 → 429', async () => {
    const body = { email: 'a@x.com', password: 'wrong' };
    expect(await statusOf(loginPOST, body, 'ip-2')).toBe(401);
    expect(await statusOf(loginPOST, body, 'ip-2')).toBe(401);
    expect(await statusOf(loginPOST, body, 'ip-2')).toBe(429);
});

test('login 聚合桶：同 IP 不同邮箱超限额 → 429（防密码喷洒）', async () => {
    for (const email of ['a@x.com', 'b@x.com', 'c@x.com']) {
        expect(await statusOf(loginPOST, { email, password: 'x' }, 'ip-3')).toBe(401);
    }
    expect(await statusOf(loginPOST, { email: 'd@x.com', password: 'x' }, 'ip-3')).toBe(429);
});
