import { error, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { db, schema } from '$server/db';
import { verifyPassword } from '$server/auth';
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

        const user = db.select().from(schema.users).where(eq(schema.users.email, email)).get();
        if (!user || !(await verifyPassword(password, user.passwordHash))) {
            error(401, '邮箱或密码错误');
        }
        setSessionCookie(cookies, { userId: user.id });
        redirect(302, '/');
    }
};
