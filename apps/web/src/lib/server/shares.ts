import { randomBytes } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db, schema } from './db';
import { generateId } from './auth';

export function generateShareToken(): string {
    return randomBytes(16).toString('base64url');
}

export async function createShareLink(documentId: string): Promise<{ token: string; url: string }> {
    const token = generateShareToken();
    const baseUrl = process.env.BASE_URL ?? 'http://localhost:5173';
    db.insert(schema.shareLinks).values({
        id: generateId(),
        documentId,
        token,
        expiresAt: null,
        createdAt: Date.now()
    }).run();
    return { token, url: `${baseUrl}/s/${token}` };
}

export function getDocumentIdByShareToken(token: string): string | null {
    const row = db.select().from(schema.shareLinks).where(eq(schema.shareLinks.token, token)).get();
    if (!row) return null;
    if (row.expiresAt && row.expiresAt < Date.now()) return null;
    return row.documentId;
}
