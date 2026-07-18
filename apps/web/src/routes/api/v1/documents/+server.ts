import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticateApiToken } from '$server/apitoken-auth';
import { checkRateLimit } from '$server/ratelimit';
import { uploadDocument } from '$server/documents';
import { parsePath } from '@remote-reader/shared/paths';

const MAX_BYTES = Number(process.env.MAX_UPLOAD_BYTES ?? 5 * 1024 * 1024);
const RATE_LIMIT = {
    max: Number(process.env.RATE_LIMIT_MAX ?? 60),
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000)
};

export const POST: RequestHandler = async ({ request }) => {
    const auth = authenticateApiToken(request.headers.get('authorization'));
    if (!auth) error(401, 'invalid or missing api token');

    const rl = checkRateLimit(`upload:${auth.tokenId}`, RATE_LIMIT);
    if (!rl.allowed) error(429, 'rate limit exceeded');

    const body = await request.json().catch(() => error(400, 'invalid json'));
    const { name, content, path } = body as { name?: string; content?: string; path?: string };

    if (!name || typeof content !== 'string') error(400, 'name and content required');
    if (Buffer.byteLength(content) > MAX_BYTES) error(413, 'document too large');

    const segments = path ? parsePath(path) : [];
    const result = await uploadDocument(auth.userId, name, content, segments);
    return json(result);
};
