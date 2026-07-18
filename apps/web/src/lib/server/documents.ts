import { eq, and, isNull } from 'drizzle-orm';
import { join } from 'node:path';
import { db, schema } from './db';
import { generateId, sha256Hex } from './auth';
import { writeFile } from './storage';
import { createShareLink } from './shares';

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
    try {
        await writeFile(diskPath, content);
    } catch (e) {
        db.delete(schema.documents).where(eq(schema.documents.id, id)).run();
        throw e;
    }
    const url = await ensureShareUrl(id);
    return { id, url };
}
