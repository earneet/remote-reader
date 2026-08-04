import { sqlite, db, schema } from './db';
import { generateId } from './auth';
import { eq, and } from 'drizzle-orm';

export type Tag = { id: string; name: string };

export function listTags(ownerId: string): (Tag & { docCount: number })[] {
    const rows = sqlite.prepare(`
        SELECT t.id, t.name, COUNT(dt.document_id) AS doc_count
        FROM tags t
        LEFT JOIN document_tags dt ON dt.tag_id = t.id
        WHERE t.owner_id = ?
        GROUP BY t.id, t.name
        ORDER BY t.name COLLATE NOCASE
    `).all(ownerId) as { id: string; name: string; doc_count: number }[];
    return rows.map(r => ({ id: r.id, name: r.name, docCount: r.doc_count }));
}

export function listTagsForDoc(docId: string, ownerId: string): Tag[] {
    return sqlite.prepare(`
        SELECT t.id, t.name FROM tags t
        JOIN document_tags dt ON dt.tag_id = t.id
        WHERE t.owner_id = ? AND dt.document_id = ?
        ORDER BY t.name COLLATE NOCASE
    `).all(ownerId, docId) as Tag[];
}

export function listTagsForDocs(docIds: string[], ownerId: string): Map<string, Tag[]> {
    const map = new Map<string, Tag[]>();
    if (docIds.length === 0) return map;
    const placeholders = docIds.map(() => '?').join(',');
    const rows = sqlite.prepare(`
        SELECT dt.document_id AS docId, t.id, t.name FROM tags t
        JOIN document_tags dt ON dt.tag_id = t.id
        WHERE t.owner_id = ? AND dt.document_id IN (${placeholders})
        ORDER BY t.name COLLATE NOCASE
    `).all(ownerId, ...docIds) as { docId: string; id: string; name: string }[];
    for (const r of rows) {
        if (!map.has(r.docId)) map.set(r.docId, []);
        map.get(r.docId)!.push({ id: r.id, name: r.name });
    }
    return map;
}

const MAX_TAG_NAME = 32;

export class SetTagsError extends Error {
    code: 'not_found' | 'invalid';
    constructor(code: 'not_found' | 'invalid', message?: string) {
        super(message ?? code);
        this.code = code;
    }
}

function sanitizeTagName(raw: string): string | null {
    const n = raw.trim();
    if (!n || n.length > MAX_TAG_NAME || n.includes('/')) return null;
    return n;
}

function sanitizeNames(names: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of names) {
        const n = sanitizeTagName(raw);
        if (n && !seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
}

export function setDocTags(ownerId: string, docId: string, names: string[]): void {
    const doc = db.select().from(schema.documents)
        .where(and(eq(schema.documents.id, docId), eq(schema.documents.ownerId, ownerId)))
        .get();
    if (!doc || doc.type !== 'file') throw new SetTagsError('not_found');

    const clean = sanitizeNames(names);

    db.transaction((tx) => {
        const existing = tx.select().from(schema.tags).where(eq(schema.tags.ownerId, ownerId)).all();
        const idByName = new Map(existing.map(t => [t.name, t.id]));
        const targetIds: string[] = [];
        const now = Date.now();
        for (const name of clean) {
            let id = idByName.get(name);
            if (!id) {
                id = generateId();
                tx.insert(schema.tags).values({ id, ownerId, name, createdAt: now }).run();
                idByName.set(name, id);
            }
            targetIds.push(id);
        }
        const current = tx.select().from(schema.documentTags)
            .where(eq(schema.documentTags.documentId, docId)).all();
        const currentIds = new Set(current.map(l => l.tagId));
        const targetSet = new Set(targetIds);
        for (const id of currentIds) {
            if (!targetSet.has(id)) {
                tx.delete(schema.documentTags)
                    .where(and(eq(schema.documentTags.documentId, docId), eq(schema.documentTags.tagId, id))).run();
            }
        }
        for (const id of targetIds) {
            if (!currentIds.has(id)) {
                tx.insert(schema.documentTags).values({ tagId: id, documentId: docId }).run();
            }
        }
    });
}
