import { error, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db, schema } from '$server/db';
import { verifyPassword } from '$server/auth';
import { setSessionCookie } from '$server/session';
import { checkRateLimit } from '$server/ratelimit';
import { eq } from 'drizzle-orm';

const LOGIN_RATE_LIMIT = {
    max: Number(process.env.LOGIN_RATE_LIMIT_MAX ?? 10),
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000)
};

export const load: PageServerLoad = async ({ locals }) => {
    if (locals.user) redirect(302, '/');
    return {};
};

export const actions: Actions = {
    default: async ({ request, cookies }) => {
        const form = await request.formData();
        const email = String(form.get('email') ?? '').trim().toLowerCase();
        const password = String(form.get('password') ?? '');

        if (!email) error(400, '邮箱必填');

        const rl = checkRateLimit(`login:${email}`, LOGIN_RATE_LIMIT);
        if (!rl.allowed) error(429, '登录尝试过于频繁，请稍后再试');

        const user = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
        if (!user || !(await verifyPassword(password, user.passwordHash))) {
            error(401, '邮箱或密码错误');
        }
        setSessionCookie(cookies, { userId: user.id });
        redirect(302, '/');
    }
};
