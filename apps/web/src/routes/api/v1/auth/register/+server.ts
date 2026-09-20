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
