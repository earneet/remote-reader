import { error, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db, schema } from '$server/db';
import { hashPassword, generateId } from '$server/auth';
import { setSessionCookie } from '$server/session';
import { eq } from 'drizzle-orm';

export const load: PageServerLoad = async ({ locals }) => {
    if (locals.user) redirect(302, '/');
    return {};
};

export const actions: Actions = {
    default: async ({ request, cookies }) => {
        const form = await request.formData();
        const email = String(form.get('email') ?? '').trim().toLowerCase();
        const password = String(form.get('password') ?? '');
        const inviteCode = String(form.get('invite_code') ?? '');

        if (!email || !password) error(400, 'email 与 password 必填');
        if (inviteCode !== process.env.INITIAL_INVITE_CODE) error(403, '邀请码无效');

        const existing = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
        if (existing) error(409, '该邮箱已注册');

        const firstUser = db.select().from(schema.users).all().length === 0;
        const user = {
            id: generateId(),
            email,
            passwordHash: await hashPassword(password),
            role: (firstUser ? 'admin' : 'member') as 'admin' | 'member',
            createdAt: Date.now()
        };
        db.insert(schema.users).values(user).run();
        setSessionCookie(cookies, { userId: user.id });
        redirect(302, '/');
    }
};
