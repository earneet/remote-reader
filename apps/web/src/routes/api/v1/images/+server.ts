import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticateApiToken } from '$server/apitoken-auth';
import { checkRateLimit } from '$server/ratelimit';
import { relayImage } from '$server/images';
import { envInt } from '$server/env';

const RATE_LIMIT = { max: envInt('RATE_LIMIT_MAX', 60), windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000) };
const AUTH_FAIL_RATE_LIMIT = { max: envInt('AUTH_FAIL_RATE_LIMIT_MAX', 30), windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000) };

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
    const auth = authenticateApiToken(request.headers.get('authorization'));
    if (!auth) {
        const rl = checkRateLimit(`authfail:${getClientAddress()}`, AUTH_FAIL_RATE_LIMIT);
        if (!rl.allowed) error(429, 'too many failed auth attempts, slow down');
        error(401, 'invalid or missing api token');
    }
    const rl = checkRateLimit(`img-relay:${auth.tokenId}`, RATE_LIMIT); // 独立重桶（P1-2）：与 documents 的 upload: 桶分离——50 图文档不被文档上传挤爆
    if (!rl.allowed) error(429, 'rate limit exceeded');
    const body = await request.json().catch(() => null);
    const raw = (body ?? {}) as { image_id?: unknown; content_base64?: unknown };
    if (typeof raw.image_id !== 'string' || typeof raw.content_base64 !== 'string') error(400, 'image_id and content_base64 required');
    let data: Buffer;
    try {
        data = Buffer.from(raw.content_base64, 'base64');
    } catch {
        error(400, 'invalid base64');
    }
    // base64 解码对无效字符是宽松忽略的——不在此做严格校验：内容真值由 relayImage 的
    // sha256 字节绑定（P1-1）权威兜底，谎报/截断的字节必然 hash 不符 → invalid
    const result = await relayImage(auth.userId, raw.image_id, data);
    if (result.ok) return json({ name: result.name });
    if (result.reason === 'missing') error(404, 'image not found');
    return json({ status: 'invalid', reason: result.message }, { status: 400 }); // 与 confirm 同形状（P2-5：桥按 status 字段统一判别）
};
