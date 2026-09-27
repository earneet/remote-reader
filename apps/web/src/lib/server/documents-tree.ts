// 文档树结构查询（R-07 拆分自 documents.ts，纯移动零行为变化）：定位/查重/父链遍历/
// 子树收集——上传管线与树变更操作共用的内部助手。改树查询语义只动这里。
import { eq, and, isNull, ne, inArray } from 'drizzle-orm';
import { db, schema } from './db';
import { generateId } from './auth';

export type DocumentRow = typeof schema.documents.$inferSelect;

export const MAX_TREE_DEPTH = 1000;

// P1-4：DB 层允许同 parent 下 file 与 folder 同名（type 区分），但磁盘是同一命名空间——
// 文件名撞实体目录 rename 必 EISDIR、路径段撞文件 mkdir 必 EEXIST。统一提前为可解释的冲突错误
export class NameConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NameConflictError';
    }
}

export function findNode(
    ownerId: string,
    parentId: string | null,
    name: string,
    type: 'file' | 'folder'
): DocumentRow | undefined {
    return db.select().from(schema.documents)
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            parentId === null
                ? isNull(schema.documents.parentId)
                : eq(schema.documents.parentId, parentId),
            eq(schema.documents.name, name),
            eq(schema.documents.type, type)
        ))
        .get();
}

// 同父同名查重（M9：不区分 type——磁盘同一命名空间，file/folder 同名必冲突）。
// rename/move/createFolder 共用同一冲突规则，改规则只动这一处
export function findSiblingByName(
    ownerId: string,
    parentId: string | null,
    name: string,
    excludeId?: string
): DocumentRow | undefined {
    return db.select().from(schema.documents)
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            parentId === null
                ? isNull(schema.documents.parentId)
                : eq(schema.documents.parentId, parentId),
            eq(schema.documents.name, name),
            excludeId === undefined ? undefined : ne(schema.documents.id, excludeId)
        ))
        .get();
}

export function ensureFolder(ownerId: string, segments: string[]): string | null {
    let parentId: string | null = null;
    const now = Date.now();
    for (const seg of segments) {
        if (findNode(ownerId, parentId, seg, 'file')) {
            throw new NameConflictError(`路径段 "${seg}" 已被同名文件占用，无法作为目录`);
        }
        const existing = findNode(ownerId, parentId, seg, 'folder');
        if (existing) {
            parentId = existing.id;
            continue;
        }
        const id = generateId();
        db.insert(schema.documents).values({
            id,
            ownerId,
            parentId,
            name: seg,
            type: 'folder',
            storagePath: null,
            contentHash: null,
            sizeBytes: null,
            createdAt: now,
            updatedAt: now
        }).run();
        parentId = id;
    }
    return parentId;
}

// 行的当前逻辑路径段（根→…→行名）。父链缺失/超深时返回可达前缀（防御，正常不会发生）。
export function logicalSegmentsOf(ownerId: string, row: Pick<DocumentRow, 'parentId' | 'name'>): string[] {
    const segs: string[] = [];
    let cursor = row.parentId;
    let depth = 0;
    while (cursor !== null) {
        if (depth++ > MAX_TREE_DEPTH) break;
        const p = db.select({ parentId: schema.documents.parentId, name: schema.documents.name, ownerId: schema.documents.ownerId })
            .from(schema.documents)
            .where(eq(schema.documents.id, cursor))
            .get();
        if (!p || p.ownerId !== ownerId) break;
        segs.unshift(p.name);
        cursor = p.parentId;
    }
    segs.push(row.name);
    return segs;
}

// 父链完整性：任一祖先行缺失即断裂（delete-race 遗留的孤儿行特征——schema.parent_id 无 FK 兜底）
export function parentChainIntact(ownerId: string, row: Pick<DocumentRow, 'parentId'>): boolean {
    let cursor = row.parentId;
    let depth = 0;
    while (cursor !== null) {
        if (depth++ > MAX_TREE_DEPTH) return false;
        const p = db.select({ id: schema.documents.id, parentId: schema.documents.parentId })
            .from(schema.documents)
            .where(and(eq(schema.documents.id, cursor), eq(schema.documents.ownerId, ownerId)))
            .get();
        if (!p) return false;
        cursor = p.parentId;
    }
    return true;
}

// 收集子树内全部 file 行（含根自身若为 file；deleteNode 同款 BFS + 深度护栏）
export function collectSubtreeFiles(ownerId: string, rootId: string): DocumentRow[] {
    const root = db.select().from(schema.documents)
        .where(and(eq(schema.documents.id, rootId), eq(schema.documents.ownerId, ownerId)))
        .get();
    const out: DocumentRow[] = root?.type === 'file' ? [root] : [];
    let frontier: string[] = [rootId];
    let depth = 0;
    while (frontier.length > 0) {
        if (depth++ > MAX_TREE_DEPTH) break;
        const rows = db.select().from(schema.documents)
            .where(and(eq(schema.documents.ownerId, ownerId), inArray(schema.documents.parentId, frontier)))
            .all();
        for (const r of rows) if (r.type === 'file') out.push(r);
        frontier = rows.map((r) => r.id);
    }
    return out;
}
