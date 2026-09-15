import { sqlite, db, schema } from './db';
import { eq, and } from 'drizzle-orm';
import { listTagsForDoc } from './tags';
import type { Tag } from './tags';
import { toDocDTO, type DocDTO } from './documents';

type DocumentRow = typeof schema.documents.$inferSelect;
const MAX_TREE_DEPTH = 1000;
export const SEARCH_LIMIT = 50;

export type SearchResult = {
    doc: DocDTO;
    path: DocDTO[];
    tags: Tag[];
    snippet: string;
};

const MARK_OPEN = String.fromCodePoint(0xE000);
const MARK_CLOSE = String.fromCodePoint(0xE001);

function sanitizeFtsQuery(q: string): string {
    const trimmed = [...q].slice(0, 100).join('');
    const escaped = trimmed.replace(/"/g, '""');
    return `"${escaped}"`;
}

function escapeLike(s: string): string {
    return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

function safeSnippet(raw: string): string {
    const escaped = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped.split(MARK_OPEN).join('<mark>').split(MARK_CLOSE).join('</mark>');
}

export function getDocPath(ownerId: string, docId: string): DocumentRow[] {
    const path: DocumentRow[] = [];
    const node = db.select().from(schema.documents)
        .where(and(eq(schema.documents.id, docId), eq(schema.documents.ownerId, ownerId)))
        .get();
    if (!node) return path;
    let cursor: string | null = node.parentId;
    let depth = 0;
    while (cursor) {
        if (depth++ > MAX_TREE_DEPTH) break;
        const p = db.select().from(schema.documents)
            .where(and(eq(schema.documents.id, cursor), eq(schema.documents.ownerId, ownerId)))
            .get();
        if (!p) break;
        path.unshift(p);
        cursor = p.parentId;
    }
    return path;
}

export function searchDocuments(ownerId: string, query: string, tagNames: string[]): SearchResult[] {
    const q = query.trim();
    const tags = tagNames.map(t => t.trim()).filter(Boolean);

    const snippetById = new Map<string, string>();
    const candidateIds = new Set<string>();

    if (q) {
        const qChars = [...q].length;
        if (qChars >= 3) {
            const ftsQ = sanitizeFtsQuery(q);
            let ftsRows: { id: string; raw: string }[] = [];
            try {
                ftsRows = sqlite.prepare(`
                    SELECT d.id, highlight(docs_fts, 2, char(57344), char(57345)) AS raw
                    FROM docs_fts JOIN documents d ON d.id = docs_fts.doc_id
                    WHERE d.owner_id = ? AND docs_fts MATCH ?
                    ORDER BY bm25(docs_fts)
                    LIMIT ?
                `).all(ownerId, ftsQ, SEARCH_LIMIT) as { id: string; raw: string }[];
            } catch (e) {
                console.warn('[searchDocuments] FTS query failed, falling back to content LIKE', e);
            }
            for (const r of ftsRows) {
                candidateIds.add(r.id);
                snippetById.set(r.id, safeSnippet(r.raw));
            }
        }
        if (qChars < 3 || candidateIds.size === 0) {
            const contentLike = `%${escapeLike(q)}%`;
            const contentRows = sqlite.prepare(`
                SELECT f.doc_id AS id FROM docs_fts f
                JOIN documents d ON d.id = f.doc_id
                WHERE d.owner_id = ? AND f.content LIKE ? ESCAPE '\\'
                LIMIT ?
            `).all(ownerId, contentLike, SEARCH_LIMIT) as { id: string }[];
            for (const r of contentRows) {
                if (!candidateIds.has(r.id)) candidateIds.add(r.id);
            }
        }
        const nameLike = `%${escapeLike(q)}%`;
        // 仅 file：folder 混入会渲染成 /d/ 死链（load 层 type!=='file' 404）并挤占 SEARCH_LIMIT 名额
        const nameRows = sqlite.prepare(`
            SELECT id FROM documents WHERE owner_id = ? AND type = 'file' AND name LIKE ? ESCAPE '\\'
        `).all(ownerId, nameLike) as { id: string }[];
        for (const r of nameRows) {
            if (!candidateIds.has(r.id)) candidateIds.add(r.id);
        }
    }

    if (tags.length > 0) {
        const ph = tags.map(() => '?').join(',');
        const tagged = sqlite.prepare(`
            SELECT dt.document_id AS id FROM document_tags dt
            JOIN tags t ON t.id = dt.tag_id
            WHERE t.owner_id = ? AND t.name IN (${ph})
            GROUP BY dt.document_id
            HAVING COUNT(DISTINCT t.name) = ?
        `).all(ownerId, ...tags, tags.length) as { id: string }[];
        const taggedSet = new Set(tagged.map(r => r.id));
        if (q) {
            for (const id of [...candidateIds]) {
                if (!taggedSet.has(id)) candidateIds.delete(id);
            }
        } else {
            candidateIds.clear();
            for (const id of taggedSet) candidateIds.add(id);
        }
    }

    if (q === '' && tags.length === 0) return [];
    if (candidateIds.size === 0) return [];

    const ids = [...candidateIds];
    const ph = ids.map(() => '?').join(',');
    const docs = sqlite.prepare(`
        SELECT d.id, d.owner_id AS "ownerId", d.parent_id AS "parentId", d.name, d.type,
               d.storage_path AS "storagePath", d.content_hash AS "contentHash",
               d.size_bytes AS "sizeBytes", d.created_at AS "createdAt", d.updated_at AS "updatedAt",
               d.storage_tier AS "storageTier", d.last_viewed_at AS "lastViewedAt", d.archived_at AS "archivedAt",
               d.owner_viewed_at AS "ownerViewedAt"
        FROM documents d WHERE d.owner_id = ? AND d.type = 'file' AND d.id IN (${ph})
    `).all(ownerId, ...ids) as DocumentRow[];

    return docs.map(doc => ({
        doc: toDocDTO(doc),
        path: getDocPath(ownerId, doc.id).map(toDocDTO),
        tags: listTagsForDoc(doc.id, ownerId),
        snippet: snippetById.get(doc.id) ?? ''
    })).slice(0, SEARCH_LIMIT);
}
