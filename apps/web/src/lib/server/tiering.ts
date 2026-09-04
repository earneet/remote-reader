import { eq, and } from 'drizzle-orm';
import { unlink } from 'node:fs/promises';
import { db, sqlite, schema } from './db';
import { sha256Hex } from './auth';
import { readFile, writeFile } from './storage';
import { getObjectStore, objectKeyFor } from './object-store';
import type { ObjectStore } from './object-store';
import { getColdTierAfterDays } from './env';

type DocumentRow = typeof schema.documents.$inferSelect;

export const ARCHIVE_BATCH_LIMIT = 50;
export const TIERING_INTERVAL_MS = 3_600_000; // 1 小时

// ── 冷判定（纯函数）────────────────────────────────────────────
// 冷 = N 天内既没人看（last_viewed_at ?? created_at）也没更新（updated_at）
export function isColdCandidate(
    row: {
        type: string;
        storageTier: string;
        storagePath: string | null;
        createdAt: number;
        updatedAt: number;
        lastViewedAt: number | null;
    },
    nowMs: number,
    thresholdDays: number
): boolean {
    if (row.type !== 'file') return false;
    if (row.storageTier !== 'hot') return false;
    if (!row.storagePath) return false;
    const lastActivity = Math.max(row.lastViewedAt ?? row.createdAt, row.updatedAt);
    return nowMs - lastActivity > thresholdDays * 86_400_000;
}

// ── 按 docId 的进程内互斥锁（单实例部署：归档/回热/覆盖上传同进程，串行化防竞态丢内容，spec §4.2）
const docLocks = new Map<string, Promise<unknown>>();

export function withDocLock<T>(docId: string, fn: () => Promise<T>): Promise<T> {
    const prev = docLocks.get(docId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    docLocks.set(docId, next);
    void next
        .catch(() => {})
        .finally(() => {
            if (docLocks.get(docId) === next) docLocks.delete(docId);
        });
    return next;
}

// ── 归档：PUT → DB commit（cold + FTS 清 content）→ unlink ─────
// 顺序保证：任何崩溃点最坏只留孤儿（远端对象/本地文件），内容永不丢（spec §4.1）
async function archiveDocument(doc: DocumentRow, store: ObjectStore, days: number): Promise<'archived' | 'skipped'> {
    return withDocLock(doc.id, async () => {
        const fresh = db.select().from(schema.documents).where(eq(schema.documents.id, doc.id)).get();
        if (!fresh || fresh.type !== 'file' || fresh.storageTier !== 'hot' || !fresh.storagePath) {
            return 'skipped';
        }
        // 锁内复查冷判定：扫描快照到锁内执行期间可能刚被访问，刚看过的不归档（spec §6）
        if (!isColdCandidate(fresh, Date.now(), days)) return 'skipped';
        let content: string;
        try {
            content = await readFile(fresh.storagePath);
        } catch (e) {
            console.warn('[tiering] 本地文件不可读，跳过归档（保持 hot 不造"两边皆空"）', fresh.id, e);
            return 'skipped';
        }
        // 完整性防线：盘内容与 DB hash 不一致（损坏/篡改）绝不归档
        if (sha256Hex(content) !== fresh.contentHash) {
            console.warn('[tiering] 内容 hash 与 DB 不一致，跳过归档', fresh.id);
            return 'skipped';
        }
        await store.put(objectKeyFor(fresh), content);
        let flipped = false;
        db.transaction((tx) => {
            tx.update(schema.documents)
                .set({ storageTier: 'cold', archivedAt: Date.now() })
                .where(and(eq(schema.documents.id, fresh.id), eq(schema.documents.storageTier, 'hot')))
                .run();
            // §4.2 状态翻转验证：未翻转（被不可上锁的同步路径如 deleteNode 改变状态）则跳过 FTS 清空
            flipped = (sqlite.prepare('SELECT changes() AS n').get() as { n: number }).n > 0;
            if (flipped) sqlite.prepare("UPDATE docs_fts SET content = '' WHERE doc_id = ?").run(fresh.id);
        });
        if (!flipped) {
            // 未翻转：刚 PUT 的对象成孤儿，best-effort 清理（失败留孤儿，无害，spec §4.1）
            try { await store.delete(objectKeyFor(fresh)); } catch { /* 留孤儿，无害 */ }
            return 'skipped';
        }
        try {
            await unlink(fresh.storagePath);
        } catch (e) {
            console.warn('[tiering] 归档后删本地失败（孤儿文件，无害）', fresh.storagePath, e);
        }
        return 'archived';
    });
}

// ── 回热：GET → 写本地 → DB commit（hot + FTS 恢复）→ DELETE 远端 ──
export async function rewarmDocument(docId: string, content?: string): Promise<void> {
    return withDocLock(docId, async () => {
        const row = db.select().from(schema.documents).where(eq(schema.documents.id, docId)).get();
        if (!row || row.storageTier !== 'cold') return;
        const store = getObjectStore();
        if (!store) {
            console.warn('[tiering] 对象存储未配置，无法回热', docId);
            return;
        }
        let body = content;
        if (body === undefined) body = await store.get(objectKeyFor(row));
        if (!row.storagePath) {
            console.warn('[tiering] 冷文档缺 storagePath，无法回热', docId);
            return;
        }
        await writeFile(row.storagePath, body);
        let flipped = false;
        db.transaction((tx) => {
            tx.update(schema.documents)
                .set({ storageTier: 'hot', lastViewedAt: Date.now(), archivedAt: null })
                .where(and(eq(schema.documents.id, docId), eq(schema.documents.storageTier, 'cold')))
                .run();
            // §4.2 状态翻转验证 + FTS 与 tier 翻转同事务（deleteNode 相同模式）：
            // 未翻转（被同步 deleteNode 删行等）则跳过 FTS 恢复，防孤儿 FTS 行与索引倒退；
            // 覆盖上传与回热的交错已由 doc 锁串行化，此处防御不可上锁路径
            flipped = (sqlite.prepare('SELECT changes() AS n').get() as { n: number }).n > 0;
            if (flipped) {
                sqlite.prepare('DELETE FROM docs_fts WHERE doc_id = ?').run(docId);
                sqlite.prepare('INSERT INTO docs_fts (doc_id, name, content) VALUES (?, ?, ?)').run(docId, row.name, body);
            }
        });
        if (!flipped) return; // 本地刚写的文件留作孤儿，无害（spec §4.1）
        try {
            await store.delete(objectKeyFor(row));
        } catch (e) {
            console.warn('[tiering] 回热后删远端对象失败（孤儿对象，无害）', docId, e);
        }
    });
}

// ── 归档周期：批量扫描 + 失败隔离 ──────────────────────────────
export async function runArchiveCycle(store?: ObjectStore): Promise<number> {
    const s = store ?? getObjectStore();
    if (!s) return 0;
    const days = getColdTierAfterDays();
    const now = Date.now();
    const candidates = db.select().from(schema.documents)
        .where(eq(schema.documents.type, 'file'))
        .all()
        .filter((r) => isColdCandidate(r, now, days))
        .slice(0, ARCHIVE_BATCH_LIMIT);
    let archived = 0;
    for (const c of candidates) {
        try {
            if ((await archiveDocument(c, s, days)) === 'archived') archived++;
        } catch (e) {
            console.warn('[tiering] 归档失败，下轮重试', c.id, e);
        }
    }
    return archived;
}

// ── 调度器：启动即跑首轮（首轮失败即连通性告警，warn 不阻塞）+ 每小时一轮 ──
let schedulerStarted = false;

export function startTieringScheduler(): void {
    if (schedulerStarted) return;
    const store = getObjectStore();
    if (!store) return; // 未配置对象存储：分层整体关闭，行为与现状一致
    schedulerStarted = true;
    void runArchiveCycle(store)
        .then((n) => { if (n > 0) console.log('[tiering] 首轮归档完成', n, '篇'); })
        .catch((e) => console.warn('[tiering] 首轮归档失败（对象存储连通性待确认）', e));
    const timer = setInterval(() => {
        void runArchiveCycle(store).catch((e) => console.warn('[tiering] 归档周期失败', e));
    }, TIERING_INTERVAL_MS);
    timer.unref();
}
