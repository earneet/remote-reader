import { createHash } from 'node:crypto';

export async function hashPassword(password: string): Promise<string> {
    return Bun.password.hash(password, { algorithm: 'argon2id' });
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
    return Bun.password.verify(password, hash);
}

export function generateId(): string {
    return crypto.randomUUID() + Date.now().toString(36);
}

export function sha256Hex(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashToken(plaintext: string): string {
    return sha256Hex(plaintext);
}

export async function generateApiToken(): Promise<{ plaintext: string; hash: string }> {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    const plaintext = 'rr_' + Buffer.from(bytes).toString('base64url');
    return { plaintext, hash: hashToken(plaintext) };
}
