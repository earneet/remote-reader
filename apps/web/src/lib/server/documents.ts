// 文档域读路径与 DTO（R-07 拆分后本文件保留：列表/读取/浏览信号）+ 家族 barrel——
// 历史导入路径（路由/测试经 './documents' 或 '$server/documents' 引用）零变化。
// 树查询在 documents-tree.ts，上传管线在 documents-upload.ts，树变更在 documents-tree-ops.ts。
import { eq, and, isNull, isNotNull, sql } from 'drizzle-orm';
import { db, schema } from './db';
import { getObjectStore, objectKeyFor, ObjectNotFoundError, ArchiveUnavailableError } from './object-store';
import { rewarmDocument } from './tiering';
import { readFile, FileNotFoundError } from './storage';
import type { RecentSort, RecentDoc } from '../shared/recent';

export { NameConflictError } from './documents-tree';
export { uploadDocument } from './documents-upload';
export { createFolder, renameNode, moveNode, deleteNode } from './documents-tree-ops';
import type { DocumentRow } from './documents-tree';
export type { DocumentRow };


// 跨网络边界（页面 load / /api/recent）的文档 DTO：显式字段映射，
// storagePath/contentHash 等服务器内部实现不进载荷（P2-7）
export type DocDTO = Omit<RecentDoc, 'tags'>;

export function toDocDTO(r: DocumentRow, shared = false): DocDTO {
    return {
        id: r.id,
        parentId: r.parentId,
        name: r.name,
        type: r.type,
        sizeBytes: r.sizeBytes,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        ownerViewedAt: r.ownerViewedAt,
        storageTier: r.storageTier,
        shared
    };
}

export function listChildren(ownerId: string, parentId: string | null): DocumentRow[] {
    return db.select().from(schema.documents)
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            parentId === null
                ? isNull(schema.documents.parentId)
                : eq(schema.documents.parentId, parentId)
        ))
        .orderBy(
            sql`CASE WHEN ${schema.documents.type} = 'folder' THEN 0 ELSE 1 END`,
            sql`${schema.documents.updatedAt} DESC`
        )
        .all();
}

export function listFolders(ownerId: string): DocumentRow[] {
    return db.select().from(schema.documents)
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            eq(schema.documents.type, 'folder')
        ))
        .all();
}

// 「最近文档/浏览」视图：全局平铺该用户的文件（含 cold 归档行，只读元数据），
// sort 决定排序键与过滤（spec §5.4）：updated → updated_at DESC（现状）；viewed → owner_viewed_at DESC 且排除未浏览。
// keyset 分页：cursor 为上一页末行的 (ts, id)，严格小于比较保证无漏无重（spec §5.1）。
// id 决胜仅为全序确定性：id 非单调，同毫秒内顺序无时间语义，不影响分页正确性。
export function recentFiles(
    ownerId: string,
    sort: RecentSort,
    cursor: { ts: number; id: string } | null,
    limit: number
): DocumentRow[] {
    const conds = [
        eq(schema.documents.ownerId, ownerId),
        eq(schema.documents.type, 'file')
    ];
    if (sort === 'viewed') {
        conds.push(isNotNull(schema.documents.ownerViewedAt));
    }
    const orderCol = sort === 'viewed' ? schema.documents.ownerViewedAt : schema.documents.updatedAt;
    if (cursor) {
        conds.push(sql`(${orderCol}, ${schema.documents.id}) < (${cursor.ts}, ${cursor.id})`);
    }
    return db.select().from(schema.documents)
        .where(and(...conds))
        .orderBy(sql`${orderCol} DESC`, sql`${schema.documents.id} DESC`)
        .limit(limit)
        .all();
}

// 目录树子项计数：每个 folder 的直接子 folder / 子 file 数（parent_id 即 folder id）
export function folderChildCounts(ownerId: string): Map<string, { folders: number; files: number }> {
    const rows = db.select({
        parentId: schema.documents.parentId,
        type: schema.documents.type,
        cnt: sql<number>`count(*)`
    }).from(schema.documents)
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            isNotNull(schema.documents.parentId)
        ))
        .groupBy(schema.documents.parentId, schema.documents.type)
        .all() as { parentId: string; type: string; cnt: number }[];
    const out = new Map<string, { folders: number; files: number }>();
    for (const r of rows) {
        const entry = out.get(r.parentId) ?? { folders: 0, files: 0 };
        if (r.type === 'folder') entry.folders = r.cnt;
        else entry.files = r.cnt;
        out.set(r.parentId, entry);
    }
    return out;
}

export function getOwnedDocument(id: string, ownerId: string): DocumentRow | undefined {
    return db.select().from(schema.documents)
        .where(and(
            eq(schema.documents.id, id),
            eq(schema.documents.ownerId, ownerId)
        ))
        .get();
}

// /s/<token> 凭 token 访问（无 owner 校验），取行也走服务层而非路由内裸 db 查询
export function getDocumentById(id: string): DocumentRow | undefined {
    return db.select().from(schema.documents)
        .where(eq(schema.documents.id, id))
        .get();
}

// 冷热分层：访问时间戳（推迟冷却判定；只动 last_viewed_at，不动 updated_at 避免影响排序语义）
function touchDocument(docId: string): void {
    db.update(schema.documents).set({ lastViewedAt: Date.now() })
        .where(eq(schema.documents.id, docId)).run();
}

// 「最近浏览」信号（spec §5.3）：beacon 端点调用，仅 owner 真实浏览时触发；
// 只动 owner_viewed_at——不碰 updated_at（排序语义）/ last_viewed_at（分层语义）/ storage_tier
export function markOwnerViewed(ownerId: string, docId: string): boolean {
    const r = db.update(schema.documents).set({ ownerViewedAt: Date.now() })
        .where(and(
            eq(schema.documents.id, docId),
            eq(schema.documents.ownerId, ownerId),
            eq(schema.documents.type, 'file')
        ))
        .run();
    return r.changes > 0;
}

// 内容读取单点：hot → 本地（现状路径）；cold → 远端拉取 + fire-and-forget 回热
// 错误语义：FileNotFoundError / ObjectNotFoundError → 路由 404；ArchiveUnavailableError → 路由 503
// 自愈兜底（spec §7）：陈旧行判定与实际状态竞态时（他方刚回热/刚归档）重取行走另一条路径，防假 404
export async function readDocumentContent(doc: DocumentRow): Promise<string> {
    touchDocument(doc.id);
    if (doc.storageTier === 'cold') {
        const store = getObjectStore();
        if (!store) throw new ArchiveUnavailableError('对象存储未配置，冷文档不可读');
        let content: string;
        try {
            content = await store.get(objectKeyFor(doc));
        } catch (e) {
            if (e instanceof ObjectNotFoundError) {
                // 读取期间他方回热已完成（远端对象已删、本地已写）→ 回落读本地
                const refetch = db.select().from(schema.documents).where(eq(schema.documents.id, doc.id)).get();
                if (refetch && refetch.storageTier === 'hot' && refetch.storagePath) {
                    return readFile(refetch.storagePath);
                }
            }
            throw e;
        }
        void rewarmDocument(doc.id, content).catch((e) => {
            console.warn('[tiering] 回热失败（下次访问重试）', doc.id, e);
        });
        return content;
    }
    if (!doc.storagePath) throw new FileNotFoundError(doc.id); // 防御：hot 必有盘路径
    try {
        return await readFile(doc.storagePath);
    } catch (e) {
        if (e instanceof FileNotFoundError) {
            // 读取期间归档刚完成（本地已删、远端已存）→ 转走远端
            const refetch = db.select().from(schema.documents).where(eq(schema.documents.id, doc.id)).get();
            if (refetch && refetch.storageTier === 'cold') {
                const store = getObjectStore();
                if (store) return store.get(objectKeyFor(refetch));
            }
        }
        throw e;
    }
}
