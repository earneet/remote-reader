import { eq, and, isNull, isNotNull, inArray, ne, sql } from 'drizzle-orm';
import { dirname, join } from 'node:path';
import { renameSync, rmSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { db, schema, sqlite } from './db';
import { generateId, sha256Hex } from './auth';
import { writeFile, readFile, FileNotFoundError } from './storage';
import { rewarmDocument, withDocLock } from './tiering';
import { getObjectStore, objectKeyFor, ObjectNotFoundError, ArchiveUnavailableError } from './object-store';
import { createShareLink } from './shares';
import { getBaseUrl } from './env';
import { indexDoc } from './fts';

type DocumentRow = typeof schema.documents.$inferSelect;

const MAX_TREE_DEPTH = 1000;

function findNode(
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

function ensureFolder(ownerId: string, segments: string[]): string | null {
    let parentId: string | null = null;
    const now = Date.now();
    for (const seg of segments) {
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

async function ensureShareUrl(documentId: string): Promise<string> {
    const existing = db.select().from(schema.shareLinks)
        .where(eq(schema.shareLinks.documentId, documentId))
        .get();
    if (existing) {
        return `${getBaseUrl()}/s/${existing.token}`;
    }
    const { url } = await createShareLink(documentId);
    return url;
}

export async function uploadDocument(
    ownerId: string,
    name: string,
    content: string,
    pathSegments: string[]
): Promise<{ id: string; url: string }> {
    const parentId = ensureFolder(ownerId, pathSegments);
    const contentHash = sha256Hex(content);
    const now = Date.now();
    const diskPath = join(
        process.env.DATA_DIR ?? './data/documents',
        ownerId,
        ...pathSegments,
        name
    );

    const existing = findNode(ownerId, parentId, name, 'file');

    if (existing && existing.contentHash === contentHash) {
        const url = await ensureShareUrl(existing.id);
        return { id: existing.id, url };
    }

    if (existing) {
        // §4.2：覆盖上传写段持 doc 锁（与归档/回热串行，防竞态丢内容）；锁内重取行拿最新状态
        return withDocLock(existing.id, async () => {
            const row = db.select().from(schema.documents).where(eq(schema.documents.id, existing.id)).get();
            // 锁等待期间行被删：重取与递归之间无 await（原子窗口），递归走全新插入、不会重入本锁
            if (!row) return uploadDocument(ownerId, name, content, pathSegments);
            // 锁内复查幂等：等锁期间内容可能已被并发上传改为相同内容
            if (row.contentHash === contentHash) {
                const url = await ensureShareUrl(row.id);
                return { id: row.id, url };
            }
            await writeFile(diskPath, content);
            db.update(schema.documents).set({
                storagePath: diskPath,
                contentHash,
                sizeBytes: Buffer.byteLength(content),
                updatedAt: now,
                // 覆盖上传即回热：内容已重新落盘
                storageTier: 'hot',
                lastViewedAt: now,
                archivedAt: null
            }).where(eq(schema.documents.id, row.id)).run();
            indexDoc(row.id, name, content);
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
            return { id: row.id, url };
        });
    }

    const id = generateId();
    // H2: 先写盘后落库——崩溃窗口只留孤儿磁盘文件（可清理），不留孤儿 DB 行（会让查看/管理页 500）。
    // writeFile 已原子（tmp→rename），不会损坏已有内容。
    await writeFile(diskPath, content);
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
        try {
            await unlink(diskPath);
        } catch {}
        throw e;
    }
    indexDoc(id, name, content);
    const url = await ensureShareUrl(id);
    return { id, url };
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

// 「最近文档」视图：全局按 updated_at DESC 平铺该用户的文件（含 cold 归档行，只读元数据），
// keyset 分页：cursor 为上一页末行的 (updatedAt, id)，严格小于比较保证无漏无重（spec §5.1）。
// id 决胜仅为全序确定性：id 非单调，同毫秒内顺序无时间语义，不影响分页正确性。
export function recentFiles(
    ownerId: string,
    cursor: { updatedAt: number; id: string } | null,
    limit: number
): DocumentRow[] {
    const conds = [
        eq(schema.documents.ownerId, ownerId),
        eq(schema.documents.type, 'file')
    ];
    if (cursor) {
        conds.push(sql`(${schema.documents.updatedAt}, ${schema.documents.id}) < (${cursor.updatedAt}, ${cursor.id})`);
    }
    return db.select().from(schema.documents)
        .where(and(...conds))
        .orderBy(sql`${schema.documents.updatedAt} DESC`, sql`${schema.documents.id} DESC`)
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

export function renameNode(
    ownerId: string,
    id: string,
    newName: string
): { ok: boolean; reason?: string; code?: 'not_found' | 'conflict' | 'invalid' } {
    const node = db.select().from(schema.documents)
        .where(and(eq(schema.documents.id, id), eq(schema.documents.ownerId, ownerId)))
        .get();
    if (!node) return { ok: false, reason: '节点不存在或无权操作', code: 'not_found' };
    if (node.name === newName) return { ok: true };
    // M9: 拒绝同父同名同类型，避免 findNode 幂等失效与覆盖混淆
    const dup = db.select().from(schema.documents)
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            node.parentId === null ? isNull(schema.documents.parentId) : eq(schema.documents.parentId, node.parentId),
            eq(schema.documents.name, newName),
            eq(schema.documents.type, node.type),
            ne(schema.documents.id, id)
        ))
        .get();
    if (dup) return { ok: false, reason: '同名节点已存在', code: 'conflict' };
    // #42: 文件重命名同步磁盘文件与 storagePath，避免 DB 名字与磁盘路径错位、覆盖上传留孤儿
    // 冷热分层：cold 无本地文件，跳过磁盘 rename，仅更新 DB（对象 key 不含 name，远端无需动）
    if (node.type === 'file' && node.storagePath) {
        const newPath = join(dirname(node.storagePath), newName);
        if (node.storageTier === 'hot') {
            try {
                renameSync(node.storagePath, newPath);
            } catch {
                return { ok: false, reason: '磁盘重命名失败', code: 'invalid' };
            }
        }
        db.update(schema.documents).set({ name: newName, storagePath: newPath, updatedAt: Date.now() })
            .where(and(eq(schema.documents.id, id), eq(schema.documents.ownerId, ownerId)))
            .run();
    } else {
        db.update(schema.documents).set({ name: newName, updatedAt: Date.now() })
            .where(and(eq(schema.documents.id, id), eq(schema.documents.ownerId, ownerId)))
            .run();
    }
    return { ok: true };
}

export function moveNode(
    ownerId: string,
    id: string,
    newParentId: string | null
): { ok: boolean; reason?: string; code?: 'not_found' | 'invalid' | 'conflict' } {
    const node = db.select().from(schema.documents)
        .where(and(eq(schema.documents.id, id), eq(schema.documents.ownerId, ownerId)))
        .get();
    if (!node) return { ok: false, reason: '节点不存在或无权操作' };

    if (newParentId === id) return { ok: false, reason: '目标与自身相同' };

    if (newParentId !== null) {
        const target = db.select().from(schema.documents)
            .where(and(
                eq(schema.documents.id, newParentId),
                eq(schema.documents.ownerId, ownerId),
                eq(schema.documents.type, 'folder')
            ))
            .get();
        if (!target) return { ok: false, reason: '目标文件夹不存在' };

        let cursor: string | null = newParentId;
        let depth = 0;
        while (cursor !== null) {
            if (depth++ > MAX_TREE_DEPTH) return { ok: false, reason: '路径过深或存在环路' };
            if (cursor === id) return { ok: false, reason: '不能移入自身子孙' };
            const parent = db.select().from(schema.documents)
                .where(eq(schema.documents.id, cursor))
                .get();
            cursor = parent?.parentId ?? null;
        }
    }

    // M9: 目标位置已有同名同类型节点则拒绝（避免 findNode 幂等失效）
    const dup = db.select().from(schema.documents)
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            newParentId === null ? isNull(schema.documents.parentId) : eq(schema.documents.parentId, newParentId),
            eq(schema.documents.name, node.name),
            eq(schema.documents.type, node.type),
            ne(schema.documents.id, id)
        ))
        .get();
    if (dup) return { ok: false, reason: '目标位置存在同名节点', code: 'conflict' };

    db.update(schema.documents)
        .set({ parentId: newParentId, updatedAt: Date.now() })
        .where(and(
            eq(schema.documents.id, id),
            eq(schema.documents.ownerId, ownerId)
        ))
        .run();
    return { ok: true };
}

export function deleteNode(ownerId: string, id: string): void {
    const node = db.select().from(schema.documents)
        .where(and(eq(schema.documents.id, id), eq(schema.documents.ownerId, ownerId)))
        .get();
    if (!node) return;

    const subtreeIds: string[] = [id];
    let frontier: string[] = [id];
    let depth = 0;
    while (frontier.length > 0) {
        if (depth++ > MAX_TREE_DEPTH) {
            console.warn('[deleteNode] 子树深度超上限（可能 parentId 环或异常深树），仅删除已收集节点', ownerId, id);
            break;
        }
        const children = db.select({ id: schema.documents.id })
            .from(schema.documents)
            .where(and(
                eq(schema.documents.ownerId, ownerId),
                inArray(schema.documents.parentId, frontier)
            ))
            .all();
        const childIds = children.map((c) => c.id);
        subtreeIds.push(...childIds);
        frontier = childIds;
    }

    const files = db.select({
        id: schema.documents.id,
        storagePath: schema.documents.storagePath,
        storageTier: schema.documents.storageTier,
        contentHash: schema.documents.contentHash,
        ownerId: schema.documents.ownerId
    })
        .from(schema.documents)
        .where(and(inArray(schema.documents.id, subtreeIds), eq(schema.documents.type, 'file')))
        .all();

    db.transaction((tx) => {
        tx.delete(schema.shareLinks).where(inArray(schema.shareLinks.documentId, subtreeIds)).run();
        // docs_fts 非 Drizzle 表，同连接同步执行故落在事务内
        const ph = subtreeIds.map(() => '?').join(',');
        sqlite.prepare(`DELETE FROM docs_fts WHERE doc_id IN (${ph})`).run(...subtreeIds);
        tx.delete(schema.documents).where(inArray(schema.documents.id, subtreeIds)).run();
    });

    const store = getObjectStore();
    for (const f of files) {
        if (f.storageTier === 'cold') {
            // 冷文档：内容在远端（失败仅留孤儿对象，无害）
            if (store) {
                void store.delete(objectKeyFor(f)).catch((e) => {
                    console.warn('[deleteNode] 远端对象删除失败', f.id, e);
                });
            }
        } else if (f.storagePath) {
            try {
                rmSync(f.storagePath, { recursive: true, force: true });
            } catch (e) {
                console.warn('[deleteNode] disk cleanup failed', f.storagePath, e);
            }
        }
    }
}

// 冷热分层：访问时间戳（推迟冷却判定；只动 last_viewed_at，不动 updated_at 避免影响排序语义）
function touchDocument(docId: string): void {
    db.update(schema.documents).set({ lastViewedAt: Date.now() })
        .where(eq(schema.documents.id, docId)).run();
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
