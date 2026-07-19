import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { eq } from 'drizzle-orm';
import { db, schema } from '$server/db';
import { getDocumentIdByShareToken } from '$server/shares';
import { readFile, FileNotFoundError } from '$server/storage';
import { renderMarkdown } from '$server/markdown';

export const load: PageServerLoad = async ({ params }) => {
    const documentId = getDocumentIdByShareToken(params.token);
    if (!documentId) error(404, '链接已失效或不存在');

    const doc = db.select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    if (!doc || doc.type !== 'file' || !doc.storagePath) error(404, '文档不存在');

    let content: string;
    try {
        content = await readFile(doc.storagePath);
    } catch (e) {
        if (e instanceof FileNotFoundError) error(404, '文档内容缺失');
        throw e;
    }
    const html = await renderMarkdown(content);
    return { title: doc.name, html };
};
