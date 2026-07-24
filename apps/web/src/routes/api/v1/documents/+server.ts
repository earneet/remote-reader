import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticateApiToken } from '$server/apitoken-auth';
import { checkRateLimit } from '$server/ratelimit';
import { uploadDocument } from '$server/documents';
import { parsePath } from '@remote-reader/shared/paths';
import { envInt } from '$server/env';

const MAX_BYTES = envInt('MAX_UPLOAD_BYTES', 5 * 1024 * 1024);
const RATE_LIMIT = {
    max: envInt('RATE_LIMIT_MAX', 60),
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000)
};
// 认证失败按 IP 限流：防无效 token 无限速枚举（token 256 位熵使暴力不可行，此为纵深防御）。
const AUTH_FAIL_RATE_LIMIT = {
    max: envInt('AUTH_FAIL_RATE_LIMIT_MAX', 30),
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000)
};

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
    const auth = authenticateApiToken(request.headers.get('authorization'));
    if (!auth) {
        const rl = checkRateLimit(`authfail:${getClientAddress()}`, AUTH_FAIL_RATE_LIMIT);
        if (!rl.allowed) error(429, 'too many failed auth attempts, slow down');
        error(401, 'invalid or missing api token');
    }

    const rl = checkRateLimit(`upload:${auth.tokenId}`, RATE_LIMIT);
    if (!rl.allowed) error(429, 'rate limit exceeded');

    const body = await request.json().catch(() => error(400, 'invalid json'));
    const { name, content, path } = body as { name?: string; content?: string; path?: string };

    if (!name || typeof content !== 'string') error(400, 'name and content required');
    if (Buffer.byteLength(content) > MAX_BYTES) error(413, 'document too large');

    // name 与 path 都由 Agent 控制，必须一并过 parsePath：node:path.join 会归一化 ..，
    // 若 name 含 ../ 会逃出 owner 目录甚至 DATA_DIR。末段作文件名，其余作目录前缀。
    let parts: string[];
    try {
        parts = parsePath(path ? `${path}/${name}` : name);
    } catch (e) {
        error(400, (e as Error).message || 'invalid path or name');
    }
    const fileName = parts[parts.length - 1];
    const segments = parts.slice(0, -1);

    const result = await uploadDocument(auth.userId, fileName, content, segments);
    return json(result);
};
