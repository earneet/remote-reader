import { sqlite } from './db';

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
