import { error, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db, schema } from '$server/db';
import { hashPassword, generateId } from '$server/auth';
import { setSessionCookie } from '$server/session';
import { checkRateLimit } from '$server/ratelimit';
import { envInt } from '$server/env';
import { eq } from 'drizzle-orm';

const REGISTER_RATE_LIMIT = {
    max: envInt('REGISTER_RATE_LIMIT_MAX', 5),
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000)
};

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD = 8;

export const load: PageServerLoad = async ({ locals }) => {
    if (locals.user) redirect(302, '/');
    return {};
};

export const actions: Actions = {
    default: async ({ request, cookies, getClientAddress }) => {
        const form = await request.formData();
        const email = String(form.get('email') ?? '').trim().toLowerCase();
        const password = String(form.get('password') ?? '');
        const inviteCode = String(form.get('invite_code') ?? '');

        // H4: 注册限流——按 client address，防 invite code 暴力/抢注首个 admin
        const rl = checkRateLimit(`register:${getClientAddress()}`, REGISTER_RATE_LIMIT);
        if (!rl.allowed) error(429, '注册过于频繁，请稍后再试');

        if (!email || !password) error(400, 'email 与 password 必填');
        // M2: 邮箱格式 + 密码强度校验（invite-code 门槛已大幅降低用户枚举价值，409 保留以引导已注册用户登录）
        if (!EMAIL_RE.test(email)) error(400, '邮箱格式不正确');
        if (password.length < MIN_PASSWORD) error(400, `密码至少 ${MIN_PASSWORD} 位`);

        if (inviteCode !== process.env.INITIAL_INVITE_CODE) error(403, '邀请码无效');

        const existing = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
        if (existing) error(409, '该邮箱已注册');

        const passwordHash = await hashPassword(password);
        // M7: firstUser 判定 + 插入包进同步事务——better-sqlite3 同步执行，事务内不被事件循环中断，
        // 消除 check-then-act 竞态（并发首注册不会产生两个 admin）。
        const userId = db.transaction((tx) => {
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
        setSessionCookie(cookies, { userId });
        redirect(302, '/');
    }
};
