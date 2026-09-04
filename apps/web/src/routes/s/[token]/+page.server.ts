import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { eq } from 'drizzle-orm';
import { db, schema } from '$server/db';
import { getDocumentIdByShareToken } from '$server/shares';
import { readDocumentContent } from '$server/documents';
import { FileNotFoundError } from '$server/storage';
import { ArchiveUnavailableError, ObjectNotFoundError } from '$server/object-store';
import { renderMarkdown } from '$server/markdown';

export const load: PageServerLoad = async ({ params, setHeaders }) => {
    const documentId = getDocumentIdByShareToken(params.token);
    if (!documentId) error(404, '链接已失效或不存在');

    const doc = db.select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    // 冷热分层：storage_tier 是内容位置事实源，storagePath 冷态保留 → 不再作为 404 条件
    if (!doc || doc.type !== 'file') error(404, '文档不存在');

    let content: string;
    try {
        content = await readDocumentContent(doc);
    } catch (e) {
        if (e instanceof FileNotFoundError || e instanceof ObjectNotFoundError) error(404, '文档内容缺失');
        if (e instanceof ArchiveUnavailableError) error(503, '归档存储暂时不可达，请稍后重试');
        throw e;
    }
    const html = await renderMarkdown(content);
    // M1: 免登录查看页禁缓存——撤销 share token 后浏览器/CDN/bfcache 不再展示已撤销内容
    setHeaders({ 'cache-control': 'no-store' });
    return { title: doc.name, html };
};
