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
