import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticateApiToken } from '$server/apitoken-auth';
import { checkRateLimit } from '$server/ratelimit';
import { initImage, ImageInputError } from '$server/images';
import { envInt } from '$server/env';

const IMAGES_META_RATE_LIMIT = { max: envInt('IMAGES_META_RATE_LIMIT_MAX', 120), windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000) };
const AUTH_FAIL_RATE_LIMIT = { max: envInt('AUTH_FAIL_RATE_LIMIT_MAX', 30), windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000) };

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
    const auth = authenticateApiToken(request.headers.get('authorization'));
    if (!auth) {
        const rl = checkRateLimit(`authfail:${getClientAddress()}`, AUTH_FAIL_RATE_LIMIT);
        if (!rl.allowed) error(429, 'too many failed auth attempts, slow down');
        error(401, 'invalid or missing api token');
    }
    const rl = checkRateLimit(`images-meta:${auth.tokenId}`, IMAGES_META_RATE_LIMIT);
    if (!rl.allowed) error(429, 'rate limit exceeded');
    const body = await request.json().catch(() => null);
    const raw = (body ?? {}) as { name?: unknown; content_hash?: unknown; content_md5?: unknown; size_bytes?: unknown };
    if (typeof raw.name !== 'string' || typeof raw.content_hash !== 'string'
        || typeof raw.content_md5 !== 'string' || typeof raw.size_bytes !== 'number') {
        error(400, 'name, content_hash, content_md5, size_bytes required');
    }
    try {
        const result = await initImage(auth.userId, {
            name: raw.name, contentHash: raw.content_hash, contentMd5: raw.content_md5, sizeBytes: raw.size_bytes
        });
        return json(result);
    } catch (e) {
        if (e instanceof ImageInputError) error(e.status, e.message);
        throw e;
    }
};
