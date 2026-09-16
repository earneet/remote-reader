import { eq, and, isNull, isNotNull, inArray, ne, sql } from 'drizzle-orm';
import { dirname, join } from 'node:path';
import { mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { db, schema, sqlite } from './db';
import { generateId, sha256Hex } from './auth';
import { writeFile, readFile, FileNotFoundError } from './storage';
import { rewarmDocument, withDocLock } from './tiering';
import { getObjectStore, objectKeyFor, ObjectNotFoundError, ArchiveUnavailableError } from './object-store';
import { createShareLink, activeShareOf } from './shares';
import { getBaseUrl, getDataDir } from './env';
import { indexDoc, unindexDocs } from './fts';
import type { RecentSort, RecentDoc } from '../shared/recent';

type DocumentRow = typeof schema.documents.$inferSelect;

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

const MAX_TREE_DEPTH = 1000;

// P1-4：DB 层允许同 parent 下 file 与 folder 同名（type 区分），但磁盘是同一命名空间——
// 文件名撞实体目录 rename 必 EISDIR、路径段撞文件 mkdir 必 EEXIST。统一提前为可解释的冲突错误
export class NameConflictError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'NameConflictError';
    }
}

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

// 同父同名查重（M9：不区分 type——磁盘同一命名空间，file/folder 同名必冲突）。
// rename/move/createFolder 共用同一冲突规则，改规则只动这一处
function findSiblingByName(
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

function ensureFolder(ownerId: string, segments: string[]): string | null {
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
function logicalSegmentsOf(ownerId: string, row: Pick<DocumentRow, 'parentId' | 'name'>): string[] {
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
function parentChainIntact(ownerId: string, row: Pick<DocumentRow, 'parentId'>): boolean {
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

// 收集子树内全部 file 行（含根自身若为 file；deleteNode 同款 BFS + 深度护栏）
function collectSubtreeFiles(ownerId: string, rootId: string): DocumentRow[] {
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
        const url = await ensureShareUrl(id);
        return { id, url };
    }
}

export function createFolder(
    ownerId: string,
    parentId: string | null,
    name: string
): { ok: true } | { ok: false; code: 'conflict'; reason: string } {
    const dup = findSiblingByName(ownerId, parentId, name);
    if (dup) {
        return {
            ok: false,
            code: 'conflict',
            reason: dup.type === 'folder'
                ? '同名文件夹已存在'
                : '同名文件已存在（文件与文件夹不能同名）'
        };
    }
    const now = Date.now();
    db.insert(schema.documents).values({
        id: generateId(),
        ownerId,
        parentId,
        name,
        type: 'folder',
        storagePath: null,
        contentHash: null,
        sizeBytes: null,
        createdAt: now,
        updatedAt: now
    }).run();
    return { ok: true };
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
    // M9: 同父同名（不区分 type）→ 冲突，避免 findNode 幂等失效与覆盖混淆
    if (findSiblingByName(ownerId, node.parentId, newName, id)) {
        return { ok: false, reason: '同名节点已存在', code: 'conflict' };
    }
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
    // FTS name 列与 documents 同步（folder 无 FTS 行，UPDATE 落空无害）——否则改名后旧名仍可搜中
    sqlite.prepare('UPDATE docs_fts SET name = ? WHERE doc_id = ?').run(newName, id);
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

    let newParentSegs: string[] = [];
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
        newParentSegs = logicalSegmentsOf(ownerId, target);
    }

    // M9: 目标位置已有同名节点则拒绝（不区分 type）
    if (findSiblingByName(ownerId, newParentId, node.name, id)) {
        return { ok: false, reason: '目标位置存在同名节点', code: 'conflict' };
    }

    // S1：storagePath 必须始终等于行的当前逻辑路径——否则 move 后向旧路径上传会静默覆盖本行内容，
    // 两行共享一个物理文件（读错内容/删错文件/hash 永久错位）。故 move 同步迁移子树全部 file 行：
    // hot 行 renameSync 物理文件 + 重读内容对齐 hash/size/FTS；cold 行只改指针（回热按新路径落盘）。
    // 先物理后 DB（同 renameNode 先例），任一迁移失败回滚已迁移文件并整体拒绝。
    const oldNodeSegs = logicalSegmentsOf(ownerId, node);
    const plan: Array<{ row: DocumentRow; newPhys: string }> = [];
    for (const f of collectSubtreeFiles(ownerId, id)) {
        const segs = logicalSegmentsOf(ownerId, f);
        const underNode = segs.length >= oldNodeSegs.length
            && oldNodeSegs.every((s, i) => segs[i] === s);
        if (!underNode) {
            console.warn('[moveNode] 子树行逻辑路径异常，跳过该行迁移', ownerId, f.id);
            continue;
        }
        plan.push({
            row: f,
            newPhys: join(getDataDir(), ownerId, ...newParentSegs, node.name, ...segs.slice(oldNodeSegs.length))
        });
    }
    const doneRenames: Array<[string, string]> = [];
    // IO（rename + 预读对齐 hash/size）全部在事务外完成，事务内只剩纯 DB 操作——
    // 事务一旦失败可整体回滚物理迁移，绝不留下「文件已迁走、DB 说还在原处」的子树级 404 错位（P2-1）
    const rehash = new Map<string, { contentHash: string; sizeBytes: number; content: string }>();
    const rollbackRenames = (): void => {
        for (const [cur, orig] of doneRenames.reverse()) {
            try { renameSync(cur, orig); } catch { /* 回滚尽力而为 */ }
        }
    };
    try {
        for (const p of plan) {
            if (p.row.storageTier !== 'hot' || !p.row.storagePath || p.newPhys === p.row.storagePath) continue;
            mkdirSync(dirname(p.newPhys), { recursive: true });
            try {
                renameSync(p.row.storagePath, p.newPhys);
            } catch (e) {
                if ((e as { code?: string }).code !== 'ENOENT') throw e; // 源文件缺失（孤儿行）→ 仅修指针
                continue;
            }
            doneRenames.push([p.newPhys, p.row.storagePath]);
            const content = readFileSync(p.newPhys, 'utf-8');
            rehash.set(p.row.id, { contentHash: sha256Hex(content), sizeBytes: Buffer.byteLength(content), content });
        }
    } catch (e) {
        rollbackRenames();
        return { ok: false, reason: `磁盘迁移失败：${(e as Error).message}`, code: 'invalid' };
    }
    try {
        db.transaction((tx) => {
            tx.update(schema.documents)
                .set({ parentId: newParentId, updatedAt: Date.now() })
                .where(and(eq(schema.documents.id, id), eq(schema.documents.ownerId, ownerId)))
                .run();
            for (const p of plan) {
                if (rehash.has(p.row.id)) {
                    const r = rehash.get(p.row.id)!;
                    tx.update(schema.documents).set({
                        storagePath: p.newPhys,
                        contentHash: r.contentHash,
                        sizeBytes: r.sizeBytes
                    }).where(eq(schema.documents.id, p.row.id)).run();
                    indexDoc(p.row.id, p.row.name, r.content);
                } else if (p.newPhys !== p.row.storagePath) {
                    tx.update(schema.documents).set({ storagePath: p.newPhys })
                        .where(eq(schema.documents.id, p.row.id)).run();
                }
            }
        });
    } catch (e) {
        rollbackRenames();
        return { ok: false, reason: `迁移落库失败：${(e as Error).message}`, code: 'invalid' };
    }
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
        // unindexDocs 为同连接同步执行，在事务回调内调用即落同一事务（语义等同原内联 SQL）
        unindexDocs(subtreeIds);
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
