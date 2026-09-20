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
