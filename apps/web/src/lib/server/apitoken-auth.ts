import { eq } from 'drizzle-orm';
import { db, schema } from './db';
import { hashToken } from './auth';

export function authenticateApiToken(
    authHeader: string | null
): { userId: string; tokenId: string } | null {
    if (!authHeader?.startsWith('Bearer ')) return null;
    const plaintext = authHeader.slice('Bearer '.length).trim();
    const row = db.select({ token: schema.apiTokens, user: schema.users })
        .from(schema.apiTokens)
        .innerJoin(schema.users, eq(schema.apiTokens.userId, schema.users.id))
        .where(eq(schema.apiTokens.tokenHash, hashToken(plaintext)))
        .get();
    if (!row) return null;
    db.update(schema.apiTokens)
        .set({ lastUsedAt: Date.now() })
        .where(eq(schema.apiTokens.id, row.token.id))
        .run();
    return { userId: row.user.id, tokenId: row.token.id };
}
