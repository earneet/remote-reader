import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticateApiToken } from '$server/apitoken-auth';
import { checkRateLimit } from '$server/ratelimit';
import { confirmImage } from '$server/images';
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
    const raw = (body ?? {}) as { image_id?: unknown };
    if (typeof raw.image_id !== 'string') error(400, 'image_id required');
    const result = await confirmImage(auth.userId, raw.image_id);
    if (result.ok) return json({ status: 'ok', name: result.name });
    if (result.reason === 'missing') return json({ status: 'missing' }, { status: 404 });
    return json({ status: 'invalid', reason: result.message }, { status: 400 });
};
