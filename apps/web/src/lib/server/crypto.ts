import { sha256Hex } from './auth';

const SECRET = process.env.SESSION_SECRET ?? 'dev-insecure-secret';

export function sign(payload: object): string {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = sha256Hex(body + '.' + SECRET);
    return `${body}.${sig}`;
}

export function verify(token: string): { userId: string } | null {
    const [body, sig] = token.split('.');
    if (!body || !sig) return null;
    const expected = sha256Hex(body + '.' + SECRET);
    if (expected !== sig) return null;
    try {
        const parsed = JSON.parse(Buffer.from(body, 'base64url').toString('utf-8'));
        if (typeof parsed?.userId === 'string') return { userId: parsed.userId };
        return null;
    } catch {
        return null;
    }
}
