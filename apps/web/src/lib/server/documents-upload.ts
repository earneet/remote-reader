// 上传管线 + 自愈（R-07 拆分自 documents.ts，纯移动零行为变化）：uploadDocument 及其
// squatter 自愈/单行迁移/分享链接兜底。历经 3 轮对抗审计的不变量注释随函数原样保留。
import { eq, and, isNull, ne } from 'drizzle-orm';
import { mkdirSync, readFileSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unlink } from 'node:fs/promises';
import { db, schema } from './db';
import { generateId, sha256Hex } from './auth';
import { writeFile } from './storage';
import { withDocLock } from './tiering';
import { getObjectStore, objectKeyFor } from './object-store';
import { createShareLink, activeShareOf } from './shares';
import { getBaseUrl, getDataDir } from './env';
import { indexDoc, unindexDocs } from './fts';
import { registerDocumentRefs, assertImageRefsWithinLimit } from './image-refs';
import {
    NameConflictError, findNode, ensureFolder, logicalSegmentsOf, parentChainIntact, type DocumentRow
} from './documents-tree';

// 单行自愈迁移：把陈旧行的物理文件搬到其当前逻辑位置，重读内容恢复 hash/size/FTS 不变量
// （迁移内容若在并发窗口内被改写，由此重新对齐）。源文件缺失（ENOENT，孤儿行）时仅修指针；
// 其余磁盘错误上抛，由调用方决定语义——绝不静默覆盖。
function migrateFileRow(row: DocumentRow, newPhys: string): void {
    if (newPhys === row.storagePath) return;
    if (row.storageTier === 'hot' && row.storagePath) {
        try {
            mkdirSync(dirname(newPhys), { recursive: true });
            renameSync(row.storagePath, newPhys);
        } catch (e) {
            if ((e as { code?: string }).code !== 'ENOENT') throw e;
            db.update(schema.documents).set({ storagePath: newPhys })
                .where(eq(schema.documents.id, row.id)).run();
            return;
        }
        const content = readFileSync(newPhys, 'utf-8');
        db.update(schema.documents).set({
            storagePath: newPhys,
            contentHash: sha256Hex(content),
            sizeBytes: Buffer.byteLength(content)
        }).where(eq(schema.documents.id, row.id)).run();
        indexDoc(row.id, row.name, content);
        return;
    }
    db.update(schema.documents).set({ storagePath: newPhys })
        .where(eq(schema.documents.id, row.id)).run();
}

async function ensureShareUrl(documentId: string): Promise<string> {
    // 活跃过滤（spec 2026-09-16 §3.1）：过期链接不返回，走新建
    const active = activeShareOf(documentId);
    if (active) return `${getBaseUrl()}/s/${active.token}`;
    const { url } = await createShareLink(documentId);
    return url;
}

// S1 自愈：目标盘路径被其他 file 行的陈旧 storagePath 占用时的处理。
// 必须在占位行的 doc 锁内进行——该行可能有在途的归档（flip 后 await unlink）或回热（await writeFile），
// 无锁迁移会与它们在线程池上交错（rewarm 旧内容后落覆盖新内容 → hash 永久错位；unlink 误删刚上传文件）。
// 锁内重取行并复核仍占位：等锁期间行可能已被并发处理。锁单独持有（调用方不得持有其他 doc 锁），
// 防双向互踩死锁。
async function evictStoragePathSquatter(
    ownerId: string,
    squatterId: string,
    diskPath: string
): Promise<'cleared' | 'conflict'> {
    return withDocLock(squatterId, async () => {
        const row = db.select().from(schema.documents).where(eq(schema.documents.id, squatterId)).get();
        if (!row || row.storagePath !== diskPath) return 'cleared';
        if (!parentChainIntact(ownerId, row)) {
            // 父链断裂的孤儿行（delete-race 遗留，树中不可见）：清掉它腾出路径，
            // 否则迁移目标不可达、后续同路径上传会 409 死锁（P2-2）。
            // 先删行后删文件（同 deleteNode 先例）：崩溃窗口只留无害孤儿文件，不留会让查看页 500 的孤儿行
            console.warn('[upload] 清理父链断裂的孤儿占位行', row.id, row.storagePath);
            unindexDocs([row.id]);
            db.delete(schema.shareLinks).where(eq(schema.shareLinks.documentId, row.id)).run();
            db.delete(schema.documents).where(eq(schema.documents.id, row.id)).run();
            if (row.storagePath) {
                try { await unlink(row.storagePath); } catch { /* 无物理文件——无害 */ }
            }
            return 'cleared';
        }
        const squatterPhys = join(getDataDir(), ownerId, ...logicalSegmentsOf(ownerId, row));
        if (squatterPhys === diskPath) {
            // 防御：行就在该逻辑位置却未被 findNode 命中（DB 被手工改坏时兜底）
            return 'conflict';
        }
        console.warn('[upload] 自愈：目标路径被陈旧 storagePath 占用，先迁移该行',
            row.id, row.storagePath, '->', squatterPhys);
        migrateFileRow(row, squatterPhys);
        return 'cleared';
    });
}

export async function uploadDocument(
    ownerId: string,
    name: string,
    content: string,
    pathSegments: string[]
): Promise<{ id: string; url: string }> {
    // 图片引用数量上限（交叉审查 P0）：置于所有盘/库副作用之前——原子拒绝，且新建/覆盖/幂等三分支统一拦截
    assertImageRefsWithinLimit(content);
    let parentId = ensureFolder(ownerId, pathSegments);
    if (findNode(ownerId, parentId, name, 'folder')) {
        throw new NameConflictError(`"${name}" 与同名文件夹冲突`);
    }
    const contentHash = sha256Hex(content);
    const now = Date.now();
    const diskPath = join(getDataDir(), ownerId, ...pathSegments, name);

    // 外壳重试：锁内检测到目标被并发删/改名（P2-3）、或 insert 撞唯一索引（P1-1 并发首传）时，
    // 回到壳层重新定位——绝不在 doc 锁回调内再次 withDocLock 同一 id（链式锁自死锁）
    for (let attempt = 0; ; attempt++) {
        const existing = findNode(ownerId, parentId, name, 'file');

        // S1 自愈（覆盖/新建分支统一入口）：目标盘路径若被其他 file 行的陈旧 storagePath 占用
        // （历史 move 未迁移磁盘的遗留——含 pre-fix 双陈旧行互相占位的形态），
        // 先迁走/清掉占位行再落盘——否则 writeFile（无论覆盖写还是新建写）会静默覆盖其内容。
        // 在取 existing 的锁之前单独进行（防双向占位时的嵌套锁死锁）。
        const squatter = db.select().from(schema.documents).where(and(
            eq(schema.documents.ownerId, ownerId),
            eq(schema.documents.storagePath, diskPath),
            eq(schema.documents.type, 'file'),
            existing ? ne(schema.documents.id, existing.id) : undefined
        )).get();
        if (squatter) {
            const r = await evictStoragePathSquatter(ownerId, squatter.id, diskPath);
            if (r === 'conflict') {
                throw new NameConflictError(`"${name}" 已被其他文档（${squatter.id}）占用`);
            }
        }

        if (existing && existing.contentHash === contentHash) {
            const url = await ensureShareUrl(existing.id);
            return { id: existing.id, url };
        }

        if (existing) {
            // §4.2：覆盖上传写段持 doc 锁（与归档/回热串行，防竞态丢内容）；锁内重取行拿最新状态
            const outcome = await withDocLock(existing.id, async (): Promise<
                { result: { id: string; url: string } } | { retry: true }
            > => {
                const row = db.select().from(schema.documents).where(eq(schema.documents.id, existing.id)).get();
                if (!row) return { retry: true };
                // 锁内复查幂等：等锁期间内容可能已被并发上传改为相同内容
                if (row.contentHash === contentHash) {
                    const url = await ensureShareUrl(row.id);
                    return { result: { id: row.id, url } };
                }
                await writeFile(diskPath, content);
                // P2-3/S2 翻转守卫：WHERE 带 eq(name)+parentId——写盘让出窗口内行被改名、被移动
                // （防 storagePath 错位回退到旧逻辑位置）或被删（防孤儿 FTS 行 + share_links FK 500）
                // 则 0 行落库，跳过后续写、交回壳层重试
                const flipped = db.update(schema.documents).set({
                    storagePath: diskPath,
                    contentHash,
                    sizeBytes: Buffer.byteLength(content),
                    updatedAt: now,
                    // 覆盖上传即回热：内容已重新落盘
                    storageTier: 'hot',
                    lastViewedAt: now,
                    archivedAt: null
                }).where(and(
                    eq(schema.documents.id, row.id),
                    eq(schema.documents.name, name),
                    parentId === null
                        ? isNull(schema.documents.parentId)
                        : eq(schema.documents.parentId, parentId)
                )).run().changes > 0;
                if (!flipped) return { retry: true };
                // 兜底：行此前停在别的物理位置（历史遗留的陈旧 storagePath）→ 覆盖写已落当前逻辑路径，清理旧位置
                if (row.storagePath && row.storagePath !== diskPath) {
                    try { await unlink(row.storagePath); } catch { /* 旧位置无文件（如冷档）——无害 */ }
                }
                indexDoc(row.id, name, content);
                // 图片 refs 声明式重算（R1 集合差，事务在 image-refs 内；幂等分支不经过此处）
                registerDocumentRefs(ownerId, row.id, content);
                // 旧态为 cold：清理旧远端对象（旧 key 含旧 hash；失败仅留孤儿对象，无害）
                if (row.storageTier === 'cold') {
                    const store = getObjectStore();
                    if (store) {
                        void store.delete(objectKeyFor(row)).catch((e) => {
                            console.warn('[upload] 删除旧归档对象失败（孤儿对象，无害）', row.id, e);
                        });
                    }
                }
                const url = await ensureShareUrl(row.id);
                return { result: { id: row.id, url } };
            });
            if ('result' in outcome) return outcome.result;
            if (attempt >= 2) throw new Error('上传目标被并发修改，请重试');
            continue;
        }

        const id = generateId();
        // H2: 先写盘后落库——崩溃窗口只留孤儿磁盘文件（可清理），不留孤儿 DB 行（会让查看/管理页 500）。
        // writeFile 已原子（tmp→rename），不会损坏已有内容。
        await writeFile(diskPath, content);
        // P2-2 根因封堵：写盘让出窗口内目标文件夹可能被并发删（parent_id 无 FK，插入不报错会留孤儿行）。
        // 落库前复查父目录仍在，不在则按原路径段重建（Agent 正上传到这里，重建即正确语义）
        if (parentId !== null) {
            const parentExists = db.select({ id: schema.documents.id }).from(schema.documents)
                .where(and(eq(schema.documents.id, parentId), eq(schema.documents.ownerId, ownerId)))
                .get();
            if (!parentExists) {
                parentId = ensureFolder(ownerId, pathSegments);
            }
        }
        try {
            db.insert(schema.documents).values({
                id,
                ownerId,
                parentId,
                name,
                type: 'file',
                storagePath: diskPath,
                contentHash,
                sizeBytes: Buffer.byteLength(content),
                createdAt: now,
                updatedAt: now
            }).run();
        } catch (e) {
            // P1-1：并发首传同位置撞唯一索引 → 回壳层重查（已写盘文件由下轮幂等/覆盖分支复用）
            if (e instanceof Error && (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE' && attempt < 2) continue;
            try {
                await unlink(diskPath);
            } catch {}
            throw e;
        }
        indexDoc(id, name, content);
        registerDocumentRefs(ownerId, id, content);
        const url = await ensureShareUrl(id);
        return { id, url };
    }
}
