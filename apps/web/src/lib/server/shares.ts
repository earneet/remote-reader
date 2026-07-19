import { randomBytes } from 'node:crypto';
import { eq, and, desc } from 'drizzle-orm';
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

export function listSharesByOwner(ownerId: string): Array<{
    token: string;
    documentId: string;
    documentName: string;
    createdAt: number;
    expiresAt: number | null;
}> {
    return db.select({
        token: schema.shareLinks.token,
        documentId: schema.shareLinks.documentId,
        documentName: schema.documents.name,
        createdAt: schema.shareLinks.createdAt,
        expiresAt: schema.shareLinks.expiresAt
    }).from(schema.shareLinks)
        .innerJoin(schema.documents, eq(schema.shareLinks.documentId, schema.documents.id))
        .where(eq(schema.documents.ownerId, ownerId))
        .orderBy(desc(schema.shareLinks.createdAt))
        .all();
}

export function revokeShare(ownerId: string, token: string): boolean {
    const link = db.select({ id: schema.shareLinks.id })
        .from(schema.shareLinks)
        .innerJoin(schema.documents, eq(schema.shareLinks.documentId, schema.documents.id))
        .where(and(
            eq(schema.shareLinks.token, token),
            eq(schema.documents.ownerId, ownerId)
        ))
        .get();
    if (!link) return false;
    db.delete(schema.shareLinks).where(eq(schema.shareLinks.id, link.id)).run();
    return true;
}
