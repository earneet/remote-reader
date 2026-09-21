import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, schema } from './db';
import { getBlobStore } from './blobstore';
import { extractImageNames, MAX_IMAGE_REFS } from '@remote-reader/shared/image-extract';

// 上传侧图片引用数量超限（路由层 → 413；语义同 ImageInputError 的 size 超限档）
export class TooManyImageRefsError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'TooManyImageRefsError';
    }
}

export function assertImageRefsWithinLimit(content: string): void {
    if (extractImageNames(content).length > MAX_IMAGE_REFS) {
        throw new TooManyImageRefsError(`文档图片引用超过上限 ${MAX_IMAGE_REFS}，请拆分文档`);
    }
}

/** 声明式登记（文档创建/覆盖统一入口，R1 集合差原子重算，spec §9.2）。
 *  绝不允许"先删后判再插"的分步序列——不变量 R1。 */
export function registerDocumentRefs(ownerId: string, docId: string, mdContent: string): void {
    const names = extractImageNames(mdContent);
    const { toRemove } = db.transaction((tx): { toRemove: string[] } => {
        const oldRows = tx.select({ imageId: schema.imageRefs.imageId }).from(schema.imageRefs)
            .where(eq(schema.imageRefs.documentId, docId)).all();
        const oldIds = new Set(oldRows.map((r) => r.imageId));
        // 新引用集：owner 池内按名匹配 ready 行；pending 行命中则续期（P2-6）
        const newIds = new Set<string>();
        for (const name of names) {
            const row = tx.select({ id: schema.images.id, status: schema.images.status })
                .from(schema.images)
                .where(and(eq(schema.images.ownerId, ownerId), eq(schema.images.name, name))).get();
            if (!row) continue;
            if (row.status === 'ready') newIds.add(row.id);
            else if (row.status === 'pending') {
                tx.update(schema.images).set({ createdAt: Date.now() }).where(eq(schema.images.id, row.id)).run(); // 续期：防文本引用指向 pending 名被 1h 回收释放
            }
        }
        const now = Date.now();
        for (const id of [...newIds].filter((id) => !oldIds.has(id))) {          // 先加（R1）
            tx.insert(schema.imageRefs).values({ documentId: docId, imageId: id, createdAt: now })
                .onConflictDoNothing().run();
        }
        const toRemove = [...oldIds].filter((id) => !newIds.has(id));
        for (const id of toRemove) {                                              // 后删（R1）
            tx.delete(schema.imageRefs).where(and(eq(schema.imageRefs.documentId, docId), eq(schema.imageRefs.imageId, id))).run();
        }
        return { toRemove };
    });
    // GC 检查只对 toRemove、只在事务提交后、按终态（§4.3-4）
    void gcImagesIfUnreferenced(toRemove);
}

/** 归零检查 → 条件式软删墓碑 → 事务后按 key 反查删 blob（§4.3-1/2/4）。fire-and-forget。 */
export async function gcImagesIfUnreferenced(imageIds: string[]): Promise<void> {
    for (const id of imageIds) {
        db.transaction((tx) => {
            const refCount = tx.select({ n: sql<number>`count(*)` }).from(schema.imageRefs)
                .where(eq(schema.imageRefs.imageId, id)).get()?.n ?? 0;
            if (refCount > 0) return;
            tx.update(schema.images).set({ status: 'deleted' })
                .where(and(eq(schema.images.id, id), eq(schema.images.status, 'ready'))).run();
        });
        const row = db.select({ storageBackend: schema.images.storageBackend, storageKey: schema.images.storageKey })
            .from(schema.images).where(eq(schema.images.id, id)).get();
        if (row) void deleteBlobIfOrphaned(row.storageBackend, row.storageKey);
    }
}

/** §4.3-2：物理删 blob 前反查同 key 活行——封死"行删后重传同 key 新行 → 延迟 DELETE 误删活图" */
async function deleteBlobIfOrphaned(backend: string, key: string): Promise<void> {
    const active = db.select({ id: schema.images.id }).from(schema.images)
        .where(and(eq(schema.images.storageKey, key), inArray(schema.images.status, ['pending', 'ready']))).all();
    if (active.length > 0) return; // 有活行复用同 key（重传场景）：跳过，下轮再看
    const store = getBlobStore(backend);
    if (!store) return;
    try { await store.delete(key); } catch (e) { console.warn('[img-gc] blob 删除失败（孤儿，无害）', key, e); }
}

/** 渲染替换阶段惰性补录（P1-4：content-hash 守卫——渲染期间文档被覆盖则放弃补录，防僵尸 ref） */
export function lazyRegisterRefs(ownerId: string, docId: string, expectedContentHash: string, names: string[]): void {
    db.transaction((tx) => {
        const doc = tx.select({ contentHash: schema.documents.contentHash }).from(schema.documents)
            .where(eq(schema.documents.id, docId)).get();
        if (!doc || doc.contentHash !== expectedContentHash) return; // 渲染已过期：跳过
        const now = Date.now();
        for (const name of names) {
            const row = tx.select({ id: schema.images.id }).from(schema.images)
                .where(and(eq(schema.images.ownerId, ownerId), eq(schema.images.name, name), eq(schema.images.status, 'ready'))).get();
            if (!row) continue;
            tx.insert(schema.imageRefs).values({ documentId: docId, imageId: row.id, createdAt: now })
                .onConflictDoNothing().run();
        }
    });
}

/** deleteNode 前快照：子树全部 file 行的 refs 图清单（事务内 CASCADE 前取，spec §9.3 触发一） */
export function snapshotRefsForDocuments(docIds: string[]): string[] {
    if (docIds.length === 0) return [];
    const rows = db.select({ imageId: schema.imageRefs.imageId }).from(schema.imageRefs)
        .where(inArray(schema.imageRefs.documentId, docIds)).all();
    return [...new Set(rows.map((r) => r.imageId))];
}

/** 周期回收（tiering tick 挂载，spec §9.3 触发三 + P1-2：无对象存储也必须运行）。
 *  分批 LIMIT；全部条件式；删 blob 反查。返回处理的行数（日志用）。 */
export async function runImageGcCycle(): Promise<{ pendingReaped: number; readyReaped: number; danglingRefs: number }> {
    const now = Date.now();
    const BATCH = 200;
    // 0) 悬空 ref 清理【必须最先跑——P1-3】：image_refs.image_id FK 是 ON DELETE no action 且
    //    pragma foreign_keys=ON——若悬空 ref 指向某 pending 行（防御对象正是这种历史坏态），
    //    后续物理删行会抛 SQLITE_CONSTRAINT_FOREIGNKEY 且中断整轮 GC；清理放在删除之前，
    //    收敛器才不会在坏态面前自杀
    const danglingRefs = sqlite_exec_dangling_cleanup();
    // 1) pending 超 1h：物理删行（条件式）+ 反查删 blob
    const stalePending = db.select({ id: schema.images.id }).from(schema.images)
        .where(and(eq(schema.images.status, 'pending'), lt(schema.images.createdAt, now - 3_600_000)))
        .limit(BATCH).all();
    let pendingReaped = 0;
    for (const p of stalePending) {
        const row = db.select({ storageBackend: schema.images.storageBackend, storageKey: schema.images.storageKey })
            .from(schema.images).where(eq(schema.images.id, p.id)).get();
        const deleted = db.delete(schema.images)
            .where(and(eq(schema.images.id, p.id), eq(schema.images.status, 'pending'))).run().changes > 0;
        if (deleted) { pendingReaped++; if (row) void deleteBlobIfOrphaned(row.storageBackend, row.storageKey); }
    }
    // 2) ready 无 refs 超 24h：软删墓碑 + 反查删 blob
    const staleReady = db.select({ id: schema.images.id }).from(schema.images)
        .where(and(eq(schema.images.status, 'ready'), lt(schema.images.readyAt, now - 24 * 3_600_000)))
        .limit(BATCH).all();
    let readyReaped = 0;
    const candidateIds = staleReady.map((r) => r.id);
    if (candidateIds.length > 0) {
        const refed = new Set(db.select({ imageId: schema.imageRefs.imageId }).from(schema.imageRefs)
            .where(inArray(schema.imageRefs.imageId, candidateIds)).all().map((r) => r.imageId));
        for (const id of candidateIds) {
            if (refed.has(id)) continue;
            const flipped = db.update(schema.images).set({ status: 'deleted' })
                .where(and(eq(schema.images.id, id), eq(schema.images.status, 'ready'))).run().changes > 0;
            if (flipped) {
                readyReaped++;
                const r = db.select({ storageBackend: schema.images.storageBackend, storageKey: schema.images.storageKey })
                    .from(schema.images).where(eq(schema.images.id, id)).get();
                if (r) void deleteBlobIfOrphaned(r.storageBackend, r.storageKey);
            }
        }
    }
    return { pendingReaped, readyReaped, danglingRefs };
}

function sqlite_exec_dangling_cleanup(): number {
    return db.delete(schema.imageRefs).where(sql`
        ${schema.imageRefs.imageId} IN (SELECT id FROM ${schema.images} WHERE status != 'ready')
    `).run().changes;
}
