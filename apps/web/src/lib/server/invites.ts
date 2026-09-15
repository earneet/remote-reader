import { eq, and, isNull, desc } from 'drizzle-orm';
import { db, schema } from './db';
import { generateId, generateInviteCode, hashToken } from './auth';

// 有效期白名单：创建时三选一，UI 默认 7 天
export const INVITE_EXPIRY_DAYS = [1, 7, 30] as const;
export type InviteExpiryDays = (typeof INVITE_EXPIRY_DAYS)[number];

export function listInvites(): Array<{
    id: string;
    note: string;
    creatorEmail: string;
    expiresAt: number;
    revokedAt: number | null;
    usedCount: number;
    lastUsedAt: number | null;
    createdAt: number;
}> {
    return db.select({
        id: schema.inviteCodes.id,
        note: schema.inviteCodes.note,
        creatorEmail: schema.users.email,
        expiresAt: schema.inviteCodes.expiresAt,
        revokedAt: schema.inviteCodes.revokedAt,
        usedCount: schema.inviteCodes.usedCount,
        lastUsedAt: schema.inviteCodes.lastUsedAt,
        createdAt: schema.inviteCodes.createdAt
    }).from(schema.inviteCodes)
        .innerJoin(schema.users, eq(schema.inviteCodes.createdBy, schema.users.id))
        .orderBy(desc(schema.inviteCodes.createdAt))
        .all();
}

export async function createInviteCode(
    adminId: string,
    note: string,
    days: InviteExpiryDays
): Promise<{ id: string; plaintext: string }> {
    const { plaintext, hash } = await generateInviteCode();
    const id = generateId();
    db.insert(schema.inviteCodes).values({
        id,
        codeHash: hash,
        createdBy: adminId,
        note,
        expiresAt: Date.now() + days * 86_400_000,
        revokedAt: null,
        usedCount: 0,
        lastUsedAt: null,
        createdAt: Date.now()
    }).run();
    return { id, plaintext };
}

// 软撤销：置 revoked_at；已撤销的（where isNull）不再变更，返回 false
export function revokeInvite(id: string): boolean {
    const result = db.update(schema.inviteCodes)
        .set({ revokedAt: Date.now() })
        .where(and(eq(schema.inviteCodes.id, id), isNull(schema.inviteCodes.revokedAt)))
        .run();
    return result.changes > 0;
}

// 核销（事务内版本）：哈希匹配 + 未撤销 + 未过期 → 原子 used_count+1 / last_used_at。
// better-sqlite3 同步执行，事务内不被事件循环中断（与首注册 admin 判定同一原子性理由）。
// 供需要在更大事务里核销的调用方（注册：核销与建用户同事务，失败注册不烧计数）
type InviteTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export function redeemInviteCodeTx(tx: InviteTx, plaintext: string): boolean {
    const now = Date.now();
    const row = tx.select().from(schema.inviteCodes)
        .where(eq(schema.inviteCodes.codeHash, hashToken(plaintext)))
        .get();
    if (!row || row.revokedAt !== null || row.expiresAt <= now) return false;
    tx.update(schema.inviteCodes)
        .set({ usedCount: row.usedCount + 1, lastUsedAt: now })
        .where(eq(schema.inviteCodes.id, row.id))
        .run();
    return true;
}

// 只验有效性不核销（注册流程的预检）：与 redeemInviteCodeTx 同一判定语义
export function isInviteCodeValid(plaintext: string): boolean {
    const row = db.select().from(schema.inviteCodes)
        .where(eq(schema.inviteCodes.codeHash, hashToken(plaintext)))
        .get();
    return !!row && row.revokedAt === null && row.expiresAt > Date.now();
}
