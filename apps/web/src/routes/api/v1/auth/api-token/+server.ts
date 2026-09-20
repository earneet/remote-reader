import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { createTokenForUser } from '$server/apitokens';

// Agent 程序化创建 API token（spec §5.3）：session cookie 认证（hooks 已填充 locals.user）。
// 明文仅本次响应返回（与 settings UI 一次性 reveal 同语义），不入日志。
// CSRF 三层防线：① session cookie SameSite=lax，跨站 POST 不携带 cookie（主防线）；
// ② SvelteKit 默认 csrf.checkOrigin 拦截跨站 text/plain/form 类 POST（request.json() 本身
// 不校验 Content-Type，text/plain 可夹带 JSON，此层兜住该向量）；③ 跨域 fetch 发 application/json
// 需 CORS 预检，本站无 ACAO 头。
export const POST: RequestHandler = async ({ request, locals }) => {
    if (!locals.user) error(401, '未登录');

    const body = await request.json().catch(() => null);
    const raw = (body ?? {}) as { name?: unknown };
    const name = typeof raw.name === 'string' ? raw.name.trim() : '';
    if (!name) error(400, '名称必填');

    const { plaintext } = await createTokenForUser(locals.user.id, name);
    return json({ token: plaintext });
};
