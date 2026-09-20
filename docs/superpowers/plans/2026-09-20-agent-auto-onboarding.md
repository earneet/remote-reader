# Agent 自助接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 登录页新增 SSR `<details>` Agent 接入指引块 + 新增 register/login/api-token 三个 JSON 端点，让 Agent 读页面指引后自动完成注册→登录→建 token→装桥全流程。

**Architecture:** 注册/登录核心逻辑从 form action 下沉到 `lib/server/registration.ts`（result 对象风格），form action 与新 JSON 端点共用；限流同键同桶；指引块为 `<details id="agent-guide">` 默认收起、内容始终在 SSR HTML 中供 Agent 抓取。

**Tech Stack:** SvelteKit (`+server.ts` RequestHandler)、Drizzle ORM + better-sqlite3、vitest（node 运行时）。

**Spec:** `docs/superpowers/specs/2026-09-20-agent-auto-onboarding-design.md`

---

### Task 1: 服务层 registration.ts（registerUser + authenticateUser）

**Files:**
- Create: `apps/web/src/lib/server/registration.ts`
- Test: `apps/web/tests/registration.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/web/tests/registration.test.ts`：

```typescript
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/registration.test.ts`
Expected: FAIL（`Cannot find module '../src/lib/server/registration'`）

- [ ] **Step 3: 实现 registration.ts**

创建 `apps/web/src/lib/server/registration.ts`：

```typescript
import { eq } from 'drizzle-orm';
import { db, schema } from './db';
import { hashPassword, verifyPassword, generateId } from './auth';
import { redeemInviteCodeTx, isInviteCodeValid } from './invites';

// 注册/登录核心逻辑（form action 与 /api/v1/auth/* JSON 端点共用）。
// 错误风格裁定：预期业务失败返回 result 对象，路由层转 fail()/error()。
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

// 事务内邀请码失效的信号（预检通过、核销时被并发撤销/过期）
class InviteRejected extends Error {}

export type RegisterResult = { ok: true; userId: string } | { ok: false; status: number; message: string };

export async function registerUser(input: {
    email: string;
    password: string;
    inviteCode: string;
}): Promise<RegisterResult> {
    const email = input.email.trim().toLowerCase();
    const { password, inviteCode } = input;

    if (!email || !password) return { ok: false, status: 400, message: 'email 与 password 必填' };
    if (!EMAIL_RE.test(email)) return { ok: false, status: 400, message: '邮箱格式不正确' };
    if (password.length < MIN_PASSWORD) return { ok: false, status: 400, message: `密码至少 ${MIN_PASSWORD} 位` };

    // 邀请码预检（不核销）：INITIAL_INVITE_CODE 引导码或 DB 邀请码；403 先于 409（不泄露邮箱存在性）
    const bootstrap = process.env.INITIAL_INVITE_CODE;
    const isBootstrap = !!bootstrap && inviteCode === bootstrap;
    if (!isBootstrap && !isInviteCodeValid(inviteCode)) {
        return { ok: false, status: 403, message: '邀请码无效' };
    }

    const existing = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
    if (existing) return { ok: false, status: 409, message: '该邮箱已注册' };

    const passwordHash = await hashPassword(password);
    // 核销与建用户同一事务：失败注册不烧计数；firstUser 判定 + 插入同事务（better-sqlite3 同步原子）
    try {
        const userId = db.transaction((tx) => {
            if (!isBootstrap && !redeemInviteCodeTx(tx, inviteCode)) throw new InviteRejected();
            const firstUser = tx.select().from(schema.users).all().length === 0;
            const id = generateId();
            tx.insert(schema.users).values({
                id,
                email,
                passwordHash,
                role: (firstUser ? 'admin' : 'member') as 'admin' | 'member',
                createdAt: Date.now()
            }).run();
            return id;
        });
        return { ok: true, userId };
    } catch (e) {
        if (e instanceof InviteRejected) return { ok: false, status: 403, message: '邀请码无效' };
        if (e instanceof Error && (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') {
            return { ok: false, status: 409, message: '该邮箱已注册' };
        }
        throw e;
    }
}

// 用户不存在时也对 dummy hash 跑一次 argon2 verify，响应时延与存在时一致（防邮箱枚举）
let dummyHash: string | null = null;

// email 须已由调用方归一化（trim + lowercase）——登录限流键含归一化邮箱，归一化必须在路由层先发生
export async function authenticateUser(email: string, password: string): Promise<{ id: string } | null> {
    const user = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
    if (!user) {
        if (!dummyHash) dummyHash = await hashPassword('dummy-nonexistent-user');
        await verifyPassword(password, dummyHash);
        return null;
    }
    const ok = await verifyPassword(password, user.passwordHash);
    return ok ? { id: user.id } : null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/registration.test.ts`
Expected: 6 个用例全 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/registration.ts apps/web/tests/registration.test.ts
git commit -m "feat(web): 注册/登录核心逻辑下沉 registration 服务层——registerUser/authenticateUser 供 form 与 JSON API 共用"
```

---

### Task 2: form action 改用服务层（行为不变，回归现有测试）

**Files:**
- Modify: `apps/web/src/routes/register/+page.server.ts`
- Modify: `apps/web/src/routes/login/+page.server.ts`

注意：本任务只改 actions（login 的 load 改动合并到 Task 8，因其依赖 Task 7 的 `getBridgeRepoUrl`）。

- [ ] **Step 1: 改 register/+page.server.ts**

整个文件替换为：

```typescript
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { setSessionCookie } from '$server/session';
import { checkRateLimit } from '$server/ratelimit';
import { registerUser } from '$server/registration';
import { envInt } from '$server/env';

const REGISTER_RATE_LIMIT = {
    max: envInt('REGISTER_RATE_LIMIT_MAX', 5),
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000)
};

export const load: PageServerLoad = async ({ locals }) => {
    if (locals.user) redirect(302, '/');
    return {};
};

export const actions: Actions = {
    default: async ({ request, cookies, getClientAddress }) => {
        const form = await request.formData();
        const email = String(form.get('email') ?? '');
        const password = String(form.get('password') ?? '');
        const inviteCode = String(form.get('invite_code') ?? '');

        // H4: 注册限流——按 client address，防 invite code 暴力/抢注首个 admin
        const rl = checkRateLimit(`register:${getClientAddress()}`, REGISTER_RATE_LIMIT);
        if (!rl.allowed) return fail(429, { error: '注册过于频繁，请稍后再试' });

        const result = await registerUser({ email, password, inviteCode });
        if (!result.ok) return fail(result.status, { error: result.message });

        setSessionCookie(cookies, { userId: result.userId });
        redirect(302, '/');
    }
};
```

- [ ] **Step 2: 改 login/+page.server.ts（仅 actions）**

整个文件替换为（load 保持原样不动，Task 8 再改）：

```typescript
import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { setSessionCookie } from '$server/session';
import { checkRateLimit } from '$server/ratelimit';
import { authenticateUser } from '$server/registration';
import { envInt } from '$server/env';

const LOGIN_RATE_LIMIT = {
    max: envInt('LOGIN_RATE_LIMIT_MAX', 10),
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000)
};
// P2-6：per-IP 聚合桶——(ip,email) 精确桶防不住"1 个密码 × N 个邮箱"的喷洒（每桶计数恒 1）；
// 与上传 API 的 AUTH_FAIL_RATE_LIMIT 默认 30 对称
const LOGIN_IP_RATE_LIMIT = {
    max: envInt('LOGIN_IP_RATE_LIMIT_MAX', 30),
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000)
};

export const load: PageServerLoad = async ({ locals }) => {
    if (locals.user) redirect(302, '/');
    return {};
};

export const actions: Actions = {
    default: async ({ request, cookies, getClientAddress }) => {
        const form = await request.formData();
        const email = String(form.get('email') ?? '').trim().toLowerCase();
        const password = String(form.get('password') ?? '');

        if (!email) return fail(400, { error: '邮箱必填' });

        // key 含 clientAddress + email：攻击者从其 IP 暴力某账号时，自己被限流；
        // 受害者从自身 IP 登录不受影响（防定向账号锁定 DoS）。
        // 聚合桶先判（便宜且兜跨账号喷洒），被拒即早退不消耗精确桶配额
        const ip = getClientAddress();
        const agg = checkRateLimit(`login-agg:${ip}`, LOGIN_IP_RATE_LIMIT);
        if (!agg.allowed) return fail(429, { error: '登录尝试过于频繁，请稍后再试' });
        const rl = checkRateLimit(`login:${ip}:${email}`, LOGIN_RATE_LIMIT);
        if (!rl.allowed) return fail(429, { error: '登录尝试过于频繁，请稍后再试' });

        const user = await authenticateUser(email, password);
        if (!user) return fail(401, { error: '邮箱或密码错误' });

        setSessionCookie(cookies, { userId: user.id });
        redirect(302, '/');
    }
};
```

- [ ] **Step 3: 跑回归测试**

Run: `bun run test apps/web/tests/auth-routes.test.ts apps/web/tests/login-ip-limit.test.ts apps/web/tests/auth.test.ts apps/web/tests/session.test.ts`
Expected: 全 PASS（form 行为逐字不变：status 码、error 文案、cookie、redirect）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/register/+page.server.ts apps/web/src/routes/login/+page.server.ts
git commit -m "refactor(web): register/login form action 改用 registration 服务层——行为不变，逻辑单源"
```

---

### Task 3: POST /api/v1/auth/register 端点

**Files:**
- Create: `apps/web/src/routes/api/v1/auth/register/+server.ts`
- Test: `apps/web/tests/auth-api.test.ts`（新建，本任务含 register 用例）

- [ ] **Step 1: 写失败测试**

创建 `apps/web/tests/auth-api.test.ts`：

```typescript
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

async function call(fn: (evt: any) => Promise<Response>, body: unknown, opts: { address?: string; userId?: string } = {}) {
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/auth-api.test.ts`
Expected: FAIL（`Cannot find module '../src/routes/api/v1/auth/register/+server'`）

- [ ] **Step 3: 实现端点**

创建 `apps/web/src/routes/api/v1/auth/register/+server.ts`：

```typescript
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { checkRateLimit } from '$server/ratelimit';
import { registerUser } from '$server/registration';
import { setSessionCookie } from '$server/session';
import { envInt } from '$server/env';

// 与 form action 同键同桶：两条入口共享同一配额，防换 Content-Type 绕过限流
const REGISTER_RATE_LIMIT = {
    max: envInt('REGISTER_RATE_LIMIT_MAX', 5),
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000)
};

// Agent 程序化注册（spec §5.1）：与 /register form 同语义，JSON in / JSON out，不 redirect
export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
    const rl = checkRateLimit(`register:${getClientAddress()}`, REGISTER_RATE_LIMIT);
    if (!rl.allowed) error(429, '注册过于频繁，请稍后再试');

    // body 可能是非法 JSON 或 null/标量——一律兜成 400（同 upload API 先例）
    const body = await request.json().catch(() => null);
    const raw = (body ?? {}) as { email?: unknown; password?: unknown; invite_code?: unknown };

    const result = await registerUser({
        email: typeof raw.email === 'string' ? raw.email : '',
        password: typeof raw.password === 'string' ? raw.password : '',
        inviteCode: typeof raw.invite_code === 'string' ? raw.invite_code : ''
    });
    if (!result.ok) error(result.status, result.message);

    setSessionCookie(cookies, { userId: result.userId });
    return json({ ok: true });
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/auth-api.test.ts`
Expected: register 6 个用例 PASS（login/token import 此时已可解析则一并跑，尚未有用例）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/api/v1/auth/register/+server.ts apps/web/tests/auth-api.test.ts
git commit -m "feat(web): /api/v1/auth/register JSON 端点——Agent 程序化注册（与 form 同桶限流、同事务核销邀请码）"
```

---

### Task 4: POST /api/v1/auth/login 端点

**Files:**
- Create: `apps/web/src/routes/api/v1/auth/login/+server.ts`
- Test: `apps/web/tests/auth-api.test.ts`（追加 login 用例）

- [ ] **Step 1: 追加失败测试**

在 `apps/web/tests/auth-api.test.ts` 末尾追加：

```typescript
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/auth-api.test.ts`
Expected: login 3 个用例 FAIL（`Cannot find module '.../auth/login/+server'`）

- [ ] **Step 3: 实现端点**

创建 `apps/web/src/routes/api/v1/auth/login/+server.ts`：

```typescript
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { checkRateLimit } from '$server/ratelimit';
import { authenticateUser } from '$server/registration';
import { setSessionCookie } from '$server/session';
import { envInt } from '$server/env';

// 与 form action 同键同桶（双桶：IP 聚合 + (IP,邮箱) 精确）
const LOGIN_RATE_LIMIT = {
    max: envInt('LOGIN_RATE_LIMIT_MAX', 10),
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000)
};
const LOGIN_IP_RATE_LIMIT = {
    max: envInt('LOGIN_IP_RATE_LIMIT_MAX', 30),
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000)
};

// Agent 程序化登录（spec §5.2）：与 /login form 同语义，含 dummy verify 时序恒定
export const POST: RequestHandler = async ({ request, cookies, getClientAddress }) => {
    const body = await request.json().catch(() => null);
    const raw = (body ?? {}) as { email?: unknown; password?: unknown };
    const email = typeof raw.email === 'string' ? raw.email.trim().toLowerCase() : '';
    const password = typeof raw.password === 'string' ? raw.password : '';
    if (!email) error(400, '邮箱必填');

    const ip = getClientAddress();
    const agg = checkRateLimit(`login-agg:${ip}`, LOGIN_IP_RATE_LIMIT);
    if (!agg.allowed) error(429, '登录尝试过于频繁，请稍后再试');
    const rl = checkRateLimit(`login:${ip}:${email}`, LOGIN_RATE_LIMIT);
    if (!rl.allowed) error(429, '登录尝试过于频繁，请稍后再试');

    const user = await authenticateUser(email, password);
    if (!user) error(401, '邮箱或密码错误');

    setSessionCookie(cookies, { userId: user.id });
    return json({ ok: true });
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/auth-api.test.ts`
Expected: register + login 用例全 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/api/v1/auth/login/+server.ts apps/web/tests/auth-api.test.ts
git commit -m "feat(web): /api/v1/auth/login JSON 端点——双桶限流 + dummy verify 时序恒定"
```

---

### Task 5: POST /api/v1/auth/api-token 端点

**Files:**
- Create: `apps/web/src/routes/api/v1/auth/api-token/+server.ts`
- Test: `apps/web/tests/auth-api.test.ts`（追加 token 用例）

- [ ] **Step 1: 追加失败测试**

在 `apps/web/tests/auth-api.test.ts` 末尾追加：

```typescript
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/auth-api.test.ts`
Expected: api-token 3 个用例 FAIL（`Cannot find module '.../auth/api-token/+server'`）

- [ ] **Step 3: 实现端点**

创建 `apps/web/src/routes/api/v1/auth/api-token/+server.ts`：

```typescript
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createTokenForUser } from '$server/apitokens';

// Agent 程序化创建 API token（spec §5.3）：session cookie 认证（hooks 已填充 locals.user）。
// 明文仅本次响应返回（与 settings UI 一次性 reveal 同语义），不入日志。
// CSRF：session cookie SameSite=lax，跨站 POST 不携带 cookie，天然防护。
export const POST: RequestHandler = async ({ request, locals }) => {
    if (!locals.user) error(401, '未登录');

    const body = await request.json().catch(() => null);
    const raw = (body ?? {}) as { name?: unknown };
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) error(400, '名称必填');

    const { plaintext } = await createTokenForUser(locals.user.id, name);
    return json({ token: plaintext });
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/auth-api.test.ts`
Expected: 全部用例 PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/api/v1/auth/api-token/+server.ts apps/web/tests/auth-api.test.ts
git commit -m "feat(web): /api/v1/auth/api-token 端点——session 认证创建 API token（明文一次性返回）"
```

---

### Task 6: 认证端点限流 429 覆盖

**Files:**
- Test: `apps/web/tests/auth-api-ratelimit.test.ts`（新建，小限额独立文件——envInt 在模块加载时读取，须与其他文件隔离）

- [ ] **Step 1: 写测试**

创建 `apps/web/tests/auth-api-ratelimit.test.ts`：

```typescript
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

async function statusOf(fn: (e: any) => Promise<Response>, body: unknown, address: string): Promise<number> {
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
```

- [ ] **Step 2: 跑测试**

Run: `bun run test apps/web/tests/auth-api-ratelimit.test.ts`
Expected: 3 个用例 PASS（限流 Map 跨文件共享，各用例用独立 address 前缀 ip-1/2/3 隔离；若仍受污染，把前缀改为 `ip-<文件名缩写>-N`）

- [ ] **Step 3: Commit**

```bash
git add apps/web/tests/auth-api-ratelimit.test.ts
git commit -m "test(web): 认证 JSON 端点限流 429 覆盖——register 单桶 + login 精确/聚合双桶"
```

---

### Task 7: env getBridgeRepoUrl + .env.example

**Files:**
- Modify: `apps/web/src/lib/server/env.ts`
- Modify: `apps/web/tests/env.test.ts`（追加用例）
- Modify: `.env.example`

- [ ] **Step 1: 追加失败测试**

在 `apps/web/tests/env.test.ts` 末尾追加（并把 `getBridgeRepoUrl` 加入文件顶部对 `../src/lib/server/env` 的既有 import）：

```typescript
test('getBridgeRepoUrl：默认值 / env 覆盖 / 尾斜杠归一化', () => {
    delete process.env.BRIDGE_REPO_URL;
    expect(getBridgeRepoUrl()).toBe('https://github.com/earneet/remote-reader');
    process.env.BRIDGE_REPO_URL = 'https://git.example.com/foo/bar/';
    expect(getBridgeRepoUrl()).toBe('https://git.example.com/foo/bar');
    delete process.env.BRIDGE_REPO_URL;
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/env.test.ts`
Expected: FAIL（`getBridgeRepoUrl is not a function`）

- [ ] **Step 3: 实现**

在 `apps/web/src/lib/server/env.ts` 的 `getBaseUrl` 函数之后追加：

```typescript
// 登录页 Agent 指引块展示的桥源码克隆地址（Agent 自动安装用）
export function getBridgeRepoUrl(): string {
    return (process.env.BRIDGE_REPO_URL ?? 'https://github.com/earneet/remote-reader').replace(/\/+$/, '');
}
```

`.env.example` 在 `INITIAL_INVITE_CODE=change-me` 行之后追加：

```bash
# 登录页 Agent 指引块展示的桥源码仓库地址（Agent 自动安装用，默认上游仓库）
# BRIDGE_REPO_URL=https://github.com/earneet/remote-reader
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/env.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/env.ts apps/web/tests/env.test.ts .env.example
git commit -m "feat(web): BRIDGE_REPO_URL env——登录页指引块桥源码地址可配，默认上游仓库"
```

---

### Task 8: 登录页 details 指引块（load + UI）

**Files:**
- Modify: `apps/web/src/routes/login/+page.server.ts`（load 返回 baseUrl/repoUrl）
- Modify: `apps/web/src/routes/login/+page.svelte`
- Test: `apps/web/tests/auth-api.test.ts`（追加 load 用例）

- [ ] **Step 1: 追加失败测试**

在 `apps/web/tests/auth-api.test.ts` 末尾追加：

```typescript
// ── 登录页指引块数据 ──

test('login load 返回 baseUrl/repoUrl（agent-guide SSR 注入）', async () => {
    const { load } = await import('../src/routes/login/+page.server');
    const data = await load({ locals: { user: null } } as any);
    expect(data?.baseUrl).toMatch(/^http/);
    expect(data?.repoUrl).toContain('github.com');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/auth-api.test.ts -t "login load"`
Expected: FAIL（`data.baseUrl` 为 undefined）

- [ ] **Step 3: 改 login/+page.server.ts 的 load**

import 行改为 `import { envInt, getBaseUrl, getBridgeRepoUrl } from '$server/env';`，load 改为：

```typescript
export const load: PageServerLoad = async ({ locals }) => {
    if (locals.user) redirect(302, '/');
    // Agent 指引块（details#agent-guide）SSR 注入本站地址与桥源码仓库地址
    return { baseUrl: getBaseUrl(), repoUrl: getBridgeRepoUrl() };
};
```

- [ ] **Step 4: 改 login/+page.svelte**

整个文件替换为：

```svelte
<script lang="ts">
    import { enhance } from '$app/forms';
    import AuthCard from '$components/AuthCard.svelte';
    let { data, form } = $props();
    let loading = $state(false);
    let submitBtn = $state<HTMLButtonElement | null>(null);

    // Agent 指引块的 curl/配置文本在 script 层拼装——避免模板里转义 JSON 花括号
    const cloneCmd = $derived(`git clone ${data.repoUrl} && cd remote-reader && bun install`);
    const registerCurl = $derived(`curl -c cookies.txt -X POST ${data.baseUrl}/api/v1/auth/register \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"<邮箱>","password":"<密码，至少8位>","invite_code":"<邀请码>"}'`);
    const loginCurl = $derived(`curl -c cookies.txt -X POST ${data.baseUrl}/api/v1/auth/login \\
  -H 'Content-Type: application/json' \\
  -d '{"email":"<邮箱>","password":"<密码>"}'`);
    const tokenCurl = $derived(`curl -b cookies.txt -X POST ${data.baseUrl}/api/v1/auth/api-token \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"my-agent"}'`);
    const bridgeConfig = $derived(`{"baseUrl":"${data.baseUrl}","token":"rr_..."}`);
</script>

<AuthCard title="登录" error={form?.error}>
    <form
        method="POST"
        use:enhance={() => {
            loading = true;
            return async ({ update }) => {
                await update();
                loading = false;
                // disabled 会把焦点抛回 body——失败后归还，键盘用户 Enter 重提交链不断
                submitBtn?.focus();
            };
        }}
    >
        <div class="field">
            <label for="email">邮箱</label>
            <input id="email" name="email" type="email" required autocomplete="email" />
        </div>
        <div class="field">
            <label for="password">密码</label>
            <input
                id="password"
                name="password"
                type="password"
                required
                autocomplete="current-password"
            />
        </div>
        <button type="submit" class="submit" bind:this={submitBtn} disabled={loading}>登录</button>
    </form>
    {#snippet footer()}
        没有账号？<a href="/register">注册</a>
    {/snippet}
</AuthCard>

<!-- Agent 自动接入指南：默认收起保持页面干净；内容始终在 SSR HTML 中，Agent fetch 本页即可读到全文 -->
<details class="agent-guide" id="agent-guide">
    <summary>Agent 自动接入指南（供 AI Agent 阅读）</summary>
    <div class="guide-body">
        <p>
            本站地址：<code>{data.baseUrl}</code>。如果你是 AI
            Agent，请按以下步骤用 curl 完成接入（全程无需浏览器）；注册用的邮箱与密码请和用户商量决定。
        </p>

        <h3>1. 安装本地 MCP 桥（二选一）</h3>
        <p>方式一（npm 包，如已发布）：<code>bunx remote-reader-bridge</code></p>
        <p>方式二（源码，当前可用）：</p>
        <pre><code>{cloneCmd}</code></pre>
        <p>桥入口为 <code>remote-reader/apps/mcp-bridge/src/index.ts</code>，注册进 MCP 客户端时必须写绝对路径。</p>

        <h3>2. 注册账号（已有账号请改用登录）</h3>
        <pre><code>{registerCurl}</code></pre>
        <p>成功返回 <code>{'{"ok":true}'}</code> 并种 session cookie（存入 cookies.txt）。已有账号改用登录：</p>
        <pre><code>{loginCurl}</code></pre>

        <h3>3. 创建 API token</h3>
        <pre><code>{tokenCurl}</code></pre>
        <p>返回 <code>{'{"token":"rr_..."}'}</code>，明文仅此一次返回，立即保存。</p>

        <h3>4. 配置桥</h3>
        <p>写入 <code>~/.config/remote-reader/config.json</code>：</p>
        <pre><code>{bridgeConfig}</code></pre>
        <p>（或设环境变量 <code>REMOTE_READER_URL</code> / <code>REMOTE_READER_TOKEN</code>）</p>

        <h3>5. 注册进 MCP 客户端</h3>
        <p>Claude Code：</p>
        <pre><code>claude mcp add remote-reader bun "/absolute/path/to/remote-reader/apps/mcp-bridge/src/index.ts"</code></pre>
        <p>其他客户端用标准 mcpServers JSON（入口同样写绝对路径）：</p>
        <pre><code>{'{"mcpServers":{"remote-reader":{"command":"bun","args":["/absolute/path/to/remote-reader/apps/mcp-bridge/src/index.ts"]}}}'}</code></pre>

        <h3>错误处理</h3>
        <p>
            非 2xx 响应体为 <code>{'{"message":"..."}'}</code>：403=邀请码无效（向用户索要有效邀请码）；
            409=邮箱已注册（改用登录端点）；429=限流（稍等重试）；401=session 失效（重新登录）。
            完成后即可通过 MCP 工具 <code>upload_document</code> 上传文档，返回免登录查看链接。
        </p>
    </div>
</details>

<style>
    .agent-guide {
        width: min(560px, calc(100vw - 2rem));
        margin: 1rem auto 2rem;
        background: var(--rr-card-bg);
        border: 1px solid var(--rr-card-border);
        border-radius: 12px;
        padding: 0.75rem 1.25rem;
        box-sizing: border-box;
        font-family: system-ui, -apple-system, sans-serif;
        color: var(--rr-text);
        font-size: 0.875rem;
    }

    .agent-guide summary {
        cursor: pointer;
        font-weight: 500;
        color: var(--rr-text-muted);
        user-select: none;
    }

    .agent-guide summary:hover {
        color: var(--rr-accent);
    }

    .agent-guide h3 {
        margin: 1rem 0 0.375rem;
        font-size: 0.9rem;
        color: var(--rr-text);
    }

    .agent-guide p {
        margin: 0.375rem 0;
        line-height: 1.6;
    }

    .agent-guide pre {
        margin: 0.375rem 0;
        padding: 0.6rem 0.75rem;
        background: var(--rr-input-bg);
        border: 1px solid var(--rr-border);
        border-radius: 6px;
        overflow-x: auto;
        font-size: 0.8rem;
    }

    .agent-guide code {
        color: var(--rr-text);
    }
</style>
```

- [ ] **Step 5: 跑测试 + 类型检查**

Run: `bun run test apps/web/tests/auth-api.test.ts -t "login load"` → PASS
Run: `bun --filter remote-reader-web check` → 0 error（警告不超过基线 5）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/login/+page.server.ts apps/web/src/routes/login/+page.svelte apps/web/tests/auth-api.test.ts
git commit -m "feat(web): 登录页 Agent 自动接入指南——details 折叠指引块（SSR 全文可抓取，主题变量双档）"
```

---

### Task 9: e2e-check.sh 冒烟补充

**Files:**
- Modify: `scripts/e2e-check.sh`

- [ ] **Step 1: 在末尾 `echo "✓ ..."` 行之前插入**

```bash
echo "→ 验证登录页 Agent 指引块在 SSR HTML 中"
curl -sf "$BASE/login" | grep -q 'id="agent-guide"' || { echo "FAIL: 登录页缺少 agent-guide 指引块"; exit 1; }

# 可选全链路：提供 E2E_INVITE_CODE 时验证 Agent 自助注册→建 token→上传
if [ -n "${E2E_INVITE_CODE:-}" ]; then
  echo "→ 验证 Agent 自助注册→建 token→上传全链路"
  JAR=$(mktemp)
  EMAIL="e2e-$(date +%s)@example.com"
  S=$(curl -s -o /dev/null -w "%{http_code}" -c "$JAR" -X POST "$BASE/api/v1/auth/register" \
    -H "Content-Type: application/json" \
    -d "{\"email\":\"$EMAIL\",\"password\":\"e2e-password-123\",\"invite_code\":\"$E2E_INVITE_CODE\"}")
  [ "$S" = "200" ] || { echo "FAIL: 注册应 200，实际 $S"; rm -f "$JAR"; exit 1; }
  TOKEN_JSON=$(curl -s -b "$JAR" -X POST "$BASE/api/v1/auth/api-token" \
    -H "Content-Type: application/json" -d '{"name":"e2e-agent"}')
  rm -f "$JAR"
  NEW_TOKEN=$(printf '%s' "$TOKEN_JSON" | grep -o '"token":"[^"]*"' | sed 's/"token":"//;s/"//')
  [ -n "$NEW_TOKEN" ] || { echo "FAIL: 未返回 token，实际 $TOKEN_JSON"; exit 1; }
  S=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE/api/v1/documents" \
    -H "Authorization: Bearer $NEW_TOKEN" -H "Content-Type: application/json" \
    -d '{"name":"e2e-agent.md","content":"# agent e2e","path":"checks"}')
  [ "$S" = "200" ] || { echo "FAIL: 新 token 上传应 200，实际 $S"; exit 1; }
fi
```

并把末行 `echo "✓ 子计划 1 端到端通过（...）"` 改为：

```bash
echo "✓ 端到端通过（上传→免登录查看→错误场景→agent-guide 指引块${E2E_INVITE_CODE:+→自助注册全链路}）"
```

- [ ] **Step 2: 冒烟验证（需 dev server 在跑）**

另起 dev：`cd apps/web && INITIAL_INVITE_CODE=testinvite bun run dev`
Run: `TOKEN=$(node scripts/seed-token.mjs <先注册的用户邮箱> | sed 's/^TOKEN=//') API_TOKEN=$TOKEN E2E_INVITE_CODE=testinvite BASE_URL=http://localhost:5173 bash scripts/e2e-check.sh`
Expected: 全部 ✓ 通过

- [ ] **Step 3: Commit**

```bash
git add scripts/e2e-check.sh
git commit -m "test(e2e): e2e-check 补 agent-guide 冒烟 + E2E_INVITE_CODE 自助注册→建 token→上传全链路"
```

---

### Task 10: 文档同步（中英 + AGENTS.md）

**Files:**
- Modify: `README.md` / `README.en.md`
- Modify: `docs/USER_GUIDE.md` / `docs/USER_GUIDE.en.md`
- Modify: `docs/INSTALL.md` / `docs/INSTALL.en.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: README.md**——在「## 通过 MCP 上传（Agent）」标题之前插入：

```markdown
## Agent 自助接入（发给 Agent 一句话即可）

把下面这句话发给你的 Agent（邀请码由 admin 在 `/settings/invites` 生成，或用部署时的 `INITIAL_INVITE_CODE`）：

> 请访问 https://your-host，页面 HTML 中的「Agent 自动接入指南」会指导你完成 MCP 桥安装与账号注册；使用邀请码 `<邀请码>` 注册，邮箱密码由你与我商量决定。

Agent 读取登录页 SSR 输出的 `<details id="agent-guide">` 指引块（对人默认折叠、对 Agent 始终可见），自动完成：安装本地 MCP 桥 → `POST /api/v1/auth/register` 注册 → `POST /api/v1/auth/api-token` 创建 token → 写桥配置 → 注册 MCP server。已有账号时改用 `POST /api/v1/auth/login`。
```

- [ ] **Step 2: README.en.md**——在「## Upload via MCP (Agent)」标题（对应位置）之前插入：

```markdown
## Agent self-service onboarding (one message to your agent)

Send this to your agent (invite codes are generated by an admin at `/settings/invites`, or use the deployment-time `INITIAL_INVITE_CODE`):

> Please visit https://your-host — the "Agent onboarding guide" in the page HTML will walk you through installing the MCP bridge and registering; use invite code `<code>` to register, and agree on email/password with me.

The agent reads the `<details id="agent-guide">` block in the login page's SSR HTML (collapsed for humans by default, always visible to agents) and automatically: installs the local MCP bridge → `POST /api/v1/auth/register` → `POST /api/v1/auth/api-token` → writes the bridge config → registers the MCP server. Existing accounts use `POST /api/v1/auth/login` instead.
```

- [ ] **Step 3: USER_GUIDE.md**——在「### 2.1 推荐：本地 MCP 桥」之前插入新小节：

```markdown
### 2.0 Agent 自助接入（零手工，推荐）

把这句话发给你的 Agent（替换邀请码）：

> 请访问 https://your-host，页面里的「Agent 自动接入指南」会指导你完成 MCP 桥安装与账号注册；使用邀请码 ri_xxx 注册，邮箱密码由你与我商量决定。

Agent 读取登录页 SSR HTML 中的 `<details id="agent-guide">` 指引块（对人默认折叠、对 Agent 始终可见），自动执行：

1. 安装桥：`bunx remote-reader-bridge`（npm 包，如已发布）或 `git clone <BRIDGE_REPO_URL> && bun install`
2. `POST /api/v1/auth/register`（邀请码 + 邮箱 + 密码；已有账号用 `POST /api/v1/auth/login`）→ 种 session cookie
3. `POST /api/v1/auth/api-token`（带 session cookie）→ 一次性返回 `rr_` token
4. 写 `~/.config/remote-reader/config.json` → 注册 MCP server

错误形状统一 `{"message":"..."}`：403 邀请码无效 / 409 邮箱已注册 / 429 限流 / 401 session 失效。
```

- [ ] **Step 4: USER_GUIDE.en.md**——在「### 2.1」对应位置之前插入英文版（同上内容翻译，标题 `### 2.0 Agent self-service onboarding (zero manual steps, recommended)`）。

- [ ] **Step 5: INSTALL.md**——§9 配置参考表中 `BASE_URL` 行之后插入一行：

```markdown
| `BRIDGE_REPO_URL` | `https://github.com/earneet/remote-reader` | 登录页 Agent 指引块展示的桥源码克隆地址（自定义 fork 时修改） |
```

- [ ] **Step 6: INSTALL.en.md**——配置参考表同位置插入：

```markdown
| `BRIDGE_REPO_URL` | `https://github.com/earneet/remote-reader` | Bridge source repo URL shown in the login-page agent guide (change for custom forks) |
```

- [ ] **Step 7: AGENTS.md**——在「邀请码管理（2026-09-14）」段落之后追加特性记录：

```markdown
**Agent 自助接入（2026-09-20）**：登录页 `<details id="agent-guide">` 指引块（默认收起保持页面干净、内容始终在 SSR HTML 中供 Agent 抓取——baseUrl/repoUrl 由 load 注入，repoUrl 来自新 env `BRIDGE_REPO_URL` 默认上游仓库；指引含装桥 bunx/clone 二选一、注册/登录/建 token curl、桥配置、MCP 注册、错误形状说明）+ 认证 JSON API 三端点（`POST /api/v1/auth/register` / `auth/login` / `auth/api-token`）。注册/登录核心逻辑下沉 `lib/server/registration.ts`（`registerUser` result 对象 + `authenticateUser` 时序恒定，form action 同步改用、行为不变）；限流与 form 同键同桶（register 单桶 / login 双桶）；api-token 走 session（locals.user），token 明文一次性返回；错误形状 SvelteKit `error()` 扁平 `{message}`。测试新增 registration/auth-api/auth-api-ratelimit/env 扩展 + e2e-check `agent-guide` 冒烟与 `E2E_INVITE_CODE` 全链路。spec：`docs/superpowers/specs/2026-09-20-agent-auto-onboarding-design.md`。
```

- [ ] **Step 8: Commit**

```bash
git add README.md README.en.md docs/USER_GUIDE.md docs/USER_GUIDE.en.md docs/INSTALL.md docs/INSTALL.en.md AGENTS.md
git commit -m "docs: Agent 自助接入——README/USER_GUIDE/INSTALL 中英同步 + AGENTS.md 特性记录"
```

---

### Task 11: 全量验证

- [ ] **Step 1: 全量测试**

Run: `bun run test`
Expected: 全 PASS（463 基线 + 新增约 17 用例：registration 6 + auth-api 13 + ratelimit 3 + env 1 + load 1，其中部分计入既有文件）

- [ ] **Step 2: 类型检查**

Run: `bun --filter remote-reader-web check` → 0 error
Run: `bun --filter remote-reader-mcp-bridge check` → 0 error（未动桥，确认无回归）

- [ ] **Step 3: 生产构建冒烟**

Run: `bun run build`
Expected: 构建成功（adapter-node 产物）

- [ ] **Step 4: 确认 git 状态干净**

Run: `git status --short` → 空（全部已提交）
