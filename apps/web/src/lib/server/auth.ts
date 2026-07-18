import { createHash, randomUUID, randomBytes } from 'node:crypto';
import { hash as argon2Hash, verify as argon2Verify, Algorithm } from '@node-rs/argon2';

export async function hashPassword(password: string): Promise<string> {
    return argon2Hash(password, { algorithm: Algorithm.Argon2id });
}

export async function verifyPassword(password: string, hashStr: string): Promise<boolean> {
    return argon2Verify(hashStr, password);
}

export function generateId(): string {
    return randomUUID() + Date.now().toString(36);
}

export function sha256Hex(input: string): string {
    return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashToken(plaintext: string): string {
    return sha256Hex(plaintext);
}

export async function generateApiToken(): Promise<{ plaintext: string; hash: string }> {
    const plaintext = 'rr_' + randomBytes(32).toString('base64url');
    return { plaintext, hash: hashToken(plaintext) };
}
