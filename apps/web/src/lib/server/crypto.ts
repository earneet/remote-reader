import { createHmac, timingSafeEqual } from 'node:crypto';
import { getSessionMaxAgeSeconds } from './env';

let cachedSecret: string | null = null;

function getSecret(): string {
    if (cachedSecret !== null) return cachedSecret;
    const s = process.env.SESSION_SECRET;
    if (!s) {
        if (process.env.NODE_ENV === 'production') {
            throw new Error('SESSION_SECRET must be set in production');
        }
        console.warn('[session] SESSION_SECRET 未设置，使用不安全的开发默认值');
        cachedSecret = 'dev-insecure-secret';
        return cachedSecret;
    }
    cachedSecret = s;
    return cachedSecret;
}

interface Payload {
    userId: string;
    exp: number;
}

function maxAgeMs(): number {
    return getSessionMaxAgeSeconds() * 1000;
}

function signBody(body: string): string {
    return createHmac('sha256', getSecret()).update(body).digest('hex');
}

export function sign(payload: { userId: string }): string {
    const full: Payload = { userId: payload.userId, exp: Date.now() + maxAgeMs() };
    const body = Buffer.from(JSON.stringify(full)).toString('base64url');
    return `${body}.${signBody(body)}`;
}

export function verify(token: string): { userId: string } | null {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = signBody(body);
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    try {
        const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
        if (typeof parsed?.userId !== 'string') return null;
        if (typeof parsed?.exp !== 'number' || parsed.exp < Date.now()) return null;
        return { userId: parsed.userId };
    } catch {
        return null;
    }
}
