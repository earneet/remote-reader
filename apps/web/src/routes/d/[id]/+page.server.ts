import { error, fail, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { getOwnedDocument, readDocumentContent } from '$server/documents';
import { FileNotFoundError } from '$server/storage';
import { ArchiveUnavailableError, ObjectNotFoundError } from '$server/object-store';
import { renderMarkdown } from '$server/markdown';
import { listTagsForDoc, setDocTags, SetTagsError } from '$server/tags';

export const load: PageServerLoad = async ({ locals, params, setHeaders }) => {
    if (!locals.user) redirect(302, '/login');
    const doc = getOwnedDocument(params.id, locals.user.id);
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
    const html = (await renderMarkdown(content)).html;
    const tags = listTagsForDoc(doc.id, locals.user.id);
    setHeaders({ 'cache-control': 'no-store' });
    return { id: doc.id, title: doc.name, html, tags, updatedAt: doc.updatedAt, sizeBytes: doc.sizeBytes };
};

export const actions: Actions = {
    setTags: async ({ request, locals, params }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const raw = String(form.get('tags') ?? '');
        const names = raw.split(',').map(s => s.trim()).filter(Boolean);
        for (const n of names) {
            // fail() 而非 error()：error() 信封在前端 enhance 无分支会静默（F2，对齐 FM 的 P2-10 模式）
            if (!n || n.length > 32 || n.includes('/')) return fail(400, { error: `标签名非法：${n}` });
        }
        try {
            setDocTags(locals.user.id, params.id, names);
        } catch (e) {
            if (e instanceof SetTagsError) return fail(404, { error: '文档不存在或无权操作' });
            throw e;
        }
        return { ok: true };
    }
};
