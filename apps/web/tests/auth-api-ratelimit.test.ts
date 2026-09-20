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

// 跨入口同桶：form 与 JSON 是同一限流桶的两条入口（spec §6 决策）——换 Content-Type 不能绕过限流。
// 锁定该不变量，防任一侧限流键/常量漂移后静默分桶（配额翻倍）。
test('register form 与 JSON 共享同一限流桶（跨入口不绕过）', async () => {
    const { actions } = await import('../src/routes/register/+page.server');
    const address = 'ip-4';
    const formEvent = (email: string) => {
        const fd = new FormData();
        fd.append('email', email);
        fd.append('password', 'password123');
        fd.append('invite_code', 'testinvite');
        return {
            request: new Request('http://localhost/register', { method: 'POST', body: fd }),
            cookies: { set: () => {}, get: () => undefined, delete: () => {} },
            getClientAddress: () => address
        } as any;
    };
    // form 入口消耗 2 次（max=2），JSON 第 3 次应 429——证明同桶共享计数。
    // form 成功会抛 Redirect(302)，属预期成功信号，吞掉继续。
    for (const email of ['fa@x.com', 'fb@x.com']) {
        await actions.default(formEvent(email)).catch(() => {});
    }
    expect(await statusOf(registerPOST, { email: 'fc@x.com', password: 'password123', invite_code: 'testinvite' }, address)).toBe(429);
});
