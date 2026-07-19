import { eq, and, desc } from 'drizzle-orm';
import { db, schema } from './db';
import { generateId, generateApiToken } from './auth';

export function listTokens(ownerId: string): Array<{
    id: string;
    name: string;
    createdAt: number;
    lastUsedAt: number | null;
}> {
    return db.select({
        id: schema.apiTokens.id,
        name: schema.apiTokens.name,
        createdAt: schema.apiTokens.createdAt,
        lastUsedAt: schema.apiTokens.lastUsedAt
    }).from(schema.apiTokens)
        .where(eq(schema.apiTokens.userId, ownerId))
        .orderBy(desc(schema.apiTokens.createdAt))
        .all();
}

export async function createTokenForUser(
    ownerId: string,
    name: string
): Promise<{ id: string; plaintext: string }> {
    const { plaintext, hash } = await generateApiToken();
    const id = generateId();
    db.insert(schema.apiTokens).values({
        id,
        userId: ownerId,
        name,
        tokenHash: hash,
        lastUsedAt: null,
        createdAt: Date.now()
    }).run();
    return { id, plaintext };
}

export function revokeToken(ownerId: string, id: string): boolean {
    const result = db.delete(schema.apiTokens)
        .where(and(
            eq(schema.apiTokens.id, id),
            eq(schema.apiTokens.userId, ownerId)
        ))
        .run();
    return result.changes > 0;
}
