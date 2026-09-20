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
