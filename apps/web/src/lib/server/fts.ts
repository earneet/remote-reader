import { sqlite, db, schema } from './db';
import { eq } from 'drizzle-orm';
import { readFile } from './storage';

export function indexDoc(docId: string, name: string, content: string): void {
    sqlite.prepare('DELETE FROM docs_fts WHERE doc_id = ?').run(docId);
    sqlite.prepare('INSERT INTO docs_fts (doc_id, name, content) VALUES (?, ?, ?)').run(docId, name, content);
}

export function unindexDocs(docIds: string[]): void {
    if (docIds.length === 0) return;
    const placeholders = docIds.map(() => '?').join(',');
    sqlite.prepare(`DELETE FROM docs_fts WHERE doc_id IN (${placeholders})`).run(...docIds);
}

export async function backfillFts(): Promise<void> {
    const files = db.select({ id: schema.documents.id, name: schema.documents.name, storagePath: schema.documents.storagePath })
        .from(schema.documents)
        .where(eq(schema.documents.type, 'file'))
        .all();
    if (files.length === 0) return;
    const ftsCount = (sqlite.prepare('SELECT COUNT(*) AS c FROM docs_fts').get() as { c: number }).c;
    if (ftsCount >= files.length) return;
    const indexedRows = sqlite.prepare('SELECT DISTINCT doc_id FROM docs_fts').all() as { doc_id: string }[];
    const indexed = new Set(indexedRows.map(r => r.doc_id));
    for (const f of files) {
        if (indexed.has(f.id) || !f.storagePath) continue;
        try {
            const content = await readFile(f.storagePath);
            indexDoc(f.id, f.name, content);
        } catch (e) {
            console.warn('[backfillFts] skip unreadable doc', f.id, e);
        }
    }
}
