import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db, schema } from '$server/db';
import { verifyPassword, hashPassword } from '$server/auth';
import { setSessionCookie } from '$server/session';
import { checkRateLimit } from '$server/ratelimit';
import { envInt } from '$server/env';
import { eq } from 'drizzle-orm';

const LOGIN_RATE_LIMIT = {
    max: envInt('LOGIN_RATE_LIMIT_MAX', 10),
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000)
};

// 用户不存在时也对 dummy hash 跑一次 argon2 verify，使响应时延与存在时一致（防邮箱枚举）。
let dummyHash: string | null = null;
async function verifyDummy(password: string): Promise<boolean> {
    if (!dummyHash) dummyHash = await hashPassword('dummy-nonexistent-user');
    return verifyPassword(password, dummyHash);
}

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
        const rl = checkRateLimit(`login:${getClientAddress()}:${email}`, LOGIN_RATE_LIMIT);
        if (!rl.allowed) return fail(429, { error: '登录尝试过于频繁，请稍后再试' });

        const user = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
        const ok = user ? await verifyPassword(password, user.passwordHash) : await verifyDummy(password);
        if (!user || !ok) {
            return fail(401, { error: '邮箱或密码错误' });
        }
        setSessionCookie(cookies, { userId: user.id });
        redirect(302, '/');
    }
};
