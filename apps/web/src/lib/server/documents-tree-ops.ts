// 树变更操作（R-07 拆分自 documents.ts，纯移动零行为变化）：createFolder / renameNode /
// moveNode / deleteNode——含 move 子树物理迁移与 delete 空目录回收（R-28）。
import { eq, and, inArray, isNull } from 'drizzle-orm';
import { mkdirSync, readFileSync, renameSync, rmSync, rmdirSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { db, schema, sqlite } from './db';
import { generateId, sha256Hex } from './auth';
import { getObjectStore, objectKeyFor } from './object-store';
import { getDataDir } from './env';
import { indexDoc, unindexDocs } from './fts';
import { snapshotRefsForDocuments, gcImagesIfUnreferenced } from './image-refs';
import {
    MAX_TREE_DEPTH, findSiblingByName, logicalSegmentsOf, collectSubtreeFiles, type DocumentRow
} from './documents-tree';

export function createFolder(
    ownerId: string,
    parentId: string | null,
    name: string
): { ok: true } | { ok: false; code: 'conflict' | 'not_found'; reason: string } {
    // R-26：parentId 必须是本人 folder——悬空/伪造 dir 会产出 folder-tree 不渲染的孤儿行，
    // 无 UI 可清理（与 moveNode 的 target 校验对齐；createFolder 原是 FM 五 action 唯一缺口）
    if (parentId !== null) {
        const parent = db.select().from(schema.documents)
            .where(and(eq(schema.documents.id, parentId), eq(schema.documents.ownerId, ownerId)))
            .get();
        if (!parent || parent.type !== 'folder') {
            return { ok: false, code: 'not_found', reason: '父目录不存在（可能已被删除，请刷新页面）' };
        }
    }
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

    // 图片 GC（spec §9.3 触发一）：CASCADE 删 refs 前快照受影响图清单，删后按终态归零检查
    const imageIdsForGc = snapshotRefsForDocuments(subtreeIds);

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

    // R-28：清空子树留下的物理空目录（自最深父链逐级向上 rmdir，非空即停；owner 根不越）。
    // 目录只在 writeFile 时创建，纯空 folder 链本无目录——按已删 file 的父链收敛即完备。
    // ENOTEMPTY/ENOENT 等失败静默停：并发上传 mkdir recursive 兼容已存在目录，竞态安全。
    // resolve 归一：DB storagePath（join 产物，无 ./ 前缀）与 DATA_DIR env 原值形态可能不同
    try {
        const ownerRoot = resolve(getDataDir(), ownerId);
        for (const f of files) {
            if (!f.storagePath) continue;
            let dir = resolve(dirname(f.storagePath));
            while (dir.length > ownerRoot.length && dir.startsWith(ownerRoot + sep)) {
                try {
                    rmdirSync(dir);
                } catch {
                    break; // 非空/不存在即停——兄弟链清空后的后续迭代仍会向上收敛
                }
                dir = dirname(dir);
            }
        }
    } catch {
        /* 目录清理尽力而为，不影响删除语义 */
    }

    // .catch 兜 unhandledRejection（tiering tick 同款先例）——函数自身已 per-id 容错，双保险
    void gcImagesIfUnreferenced(imageIdsForGc).catch((e) => console.warn('[img-gc] 删除文档后图片回收失败', e));
}
