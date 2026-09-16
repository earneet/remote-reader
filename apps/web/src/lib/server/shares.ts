import { randomBytes } from 'node:crypto';
import { eq, and, desc, gt, isNull, inArray, or } from 'drizzle-orm';
import { db, schema } from './db';
import { generateId } from './auth';
import { getBaseUrl } from './env';

export function generateShareToken(): string {
    return randomBytes(16).toString('base64url');
}

export async function createShareLink(documentId: string): Promise<{ token: string; url: string }> {
    const token = generateShareToken();
    db.insert(schema.shareLinks).values({
        id: generateId(),
        documentId,
        token,
        expiresAt: null,
        createdAt: Date.now()
    }).run();
    return { token, url: `${getBaseUrl()}/s/${token}` };
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

// —— spec 2026-09-16 §3.1 ——

// 活跃链接判定单源：未过期（expires_at IS NULL OR > now）；当前生产者恒 NULL，过滤为正确性预留
const activeShareCond = () => or(
    isNull(schema.shareLinks.expiresAt),
    gt(schema.shareLinks.expiresAt, Date.now())
);

// 该文档最新一条活跃链接（无 → null）；ensureShareUrl 与 getOrCreateShareUrl 共用
export function activeShareOf(documentId: string): { token: string } | null {
    return db.select({ token: schema.shareLinks.token })
        .from(schema.shareLinks)
        .where(and(eq(schema.shareLinks.documentId, documentId), activeShareCond()))
        .orderBy(desc(schema.shareLinks.createdAt))
        .get() ?? null;
}

// 批量派生：哪些文档存在活跃链接（owner join 为防御性过滤，入参本就 owner 作用域）
export function sharedDocIds(ownerId: string, docIds: string[]): Set<string> {
    if (docIds.length === 0) return new Set();
    const rows = db.select({ documentId: schema.shareLinks.documentId })
        .from(schema.shareLinks)
        .innerJoin(schema.documents, eq(schema.shareLinks.documentId, schema.documents.id))
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            inArray(schema.shareLinks.documentId, docIds),
            activeShareCond()
        ))
        .all();
    return new Set(rows.map((r) => r.documentId));
}

// FM「复制分享链接」：get-or-create；非 owner / 不存在 / folder → null（404 口径由路由层转）
export async function getOrCreateShareUrl(ownerId: string, documentId: string): Promise<string | null> {
    const doc = db.select({ type: schema.documents.type })
        .from(schema.documents)
        .where(and(eq(schema.documents.id, documentId), eq(schema.documents.ownerId, ownerId)))
        .get();
    if (!doc || doc.type !== 'file') return null;
    const active = activeShareOf(documentId);
    if (active) return `${getBaseUrl()}/s/${active.token}`;
    const { url } = await createShareLink(documentId);
    return url;
}

// FM「转为私有」：删该文档全部链接（owner 校验后按 documentId 全删——链接不存跨 owner 可能）
export function revokeAllShares(ownerId: string, documentId: string): number {
    const doc = db.select({ id: schema.documents.id })
        .from(schema.documents)
        .where(and(eq(schema.documents.id, documentId), eq(schema.documents.ownerId, ownerId)))
        .get();
    if (!doc) return 0;
    return db.delete(schema.shareLinks)
        .where(eq(schema.shareLinks.documentId, documentId))
        .run().changes;
}
