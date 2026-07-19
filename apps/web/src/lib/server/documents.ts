import { eq, and, isNull, inArray } from 'drizzle-orm';
import { join } from 'node:path';
import { rmSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { db, schema } from './db';
import { generateId, sha256Hex } from './auth';
import { writeFile } from './storage';
import { createShareLink } from './shares';

const MAX_TREE_DEPTH = 1000;

function findNode(
    ownerId: string,
    parentId: string | null,
    name: string,
    type: 'file' | 'folder'
) {
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
        const baseUrl = process.env.BASE_URL ?? 'http://localhost:5173';
        return `${baseUrl}/s/${existing.token}`;
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
        await writeFile(diskPath, content);
        db.update(schema.documents).set({
            storagePath: diskPath,
            contentHash,
            sizeBytes: Buffer.byteLength(content),
            updatedAt: now
        }).where(eq(schema.documents.id, existing.id)).run();
        const url = await ensureShareUrl(existing.id);
        return { id: existing.id, url };
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
    const url = await ensureShareUrl(id);
    return { id, url };
}

export function listChildren(ownerId: string, parentId: string | null) {
    return db.select().from(schema.documents)
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            parentId === null
                ? isNull(schema.documents.parentId)
                : eq(schema.documents.parentId, parentId)
        ))
        .all();
}

export function listFolders(ownerId: string) {
    return db.select().from(schema.documents)
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            eq(schema.documents.type, 'folder')
        ))
        .all();
}

export function getOwnedDocument(id: string, ownerId: string) {
    return db.select().from(schema.documents)
        .where(and(
            eq(schema.documents.id, id),
            eq(schema.documents.ownerId, ownerId)
        ))
        .get();
}

export function renameNode(ownerId: string, id: string, newName: string): boolean {
    const result = db.update(schema.documents)
        .set({ name: newName, updatedAt: Date.now() })
        .where(and(
            eq(schema.documents.id, id),
            eq(schema.documents.ownerId, ownerId)
        ))
        .run();
    return result.changes > 0;
}

export function moveNode(
    ownerId: string,
    id: string,
    newParentId: string | null
): { ok: boolean; reason?: string } {
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
        if (depth++ > MAX_TREE_DEPTH) break;
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

    const files = db.select({ id: schema.documents.id, storagePath: schema.documents.storagePath })
        .from(schema.documents)
        .where(and(inArray(schema.documents.id, subtreeIds), eq(schema.documents.type, 'file')))
        .all();

    db.transaction((tx) => {
        tx.delete(schema.shareLinks).where(inArray(schema.shareLinks.documentId, subtreeIds)).run();
        tx.delete(schema.documents).where(inArray(schema.documents.id, subtreeIds)).run();
    });

    for (const f of files) {
        if (f.storagePath) {
            try {
                rmSync(f.storagePath, { recursive: true, force: true });
            } catch (e) {
                console.warn('[deleteNode] disk cleanup failed', f.storagePath, e);
            }
        }
    }
}
