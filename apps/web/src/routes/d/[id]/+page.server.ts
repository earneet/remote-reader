import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { getOwnedDocument } from '$server/documents';
import { readFile, FileNotFoundError } from '$server/storage';
import { renderMarkdown } from '$server/markdown';
import { listTagsForDoc, setDocTags, SetTagsError } from '$server/tags';

export const load: PageServerLoad = async ({ locals, params, setHeaders }) => {
    if (!locals.user) redirect(302, '/login');
    const doc = getOwnedDocument(params.id, locals.user.id);
    if (!doc || doc.type !== 'file' || !doc.storagePath) error(404, '文档不存在');

    let content: string;
    try {
        content = await readFile(doc.storagePath);
    } catch (e) {
        if (e instanceof FileNotFoundError) error(404, '文档内容缺失');
        throw e;
    }
    const html = await renderMarkdown(content);
    const tags = listTagsForDoc(doc.id, locals.user.id);
    setHeaders({ 'cache-control': 'no-store' });
    return { title: doc.name, html, tags, updatedAt: doc.updatedAt, sizeBytes: doc.sizeBytes };
};

export const actions: Actions = {
    setTags: async ({ request, locals, params }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const raw = String(form.get('tags') ?? '');
        const names = raw.split(',').map(s => s.trim()).filter(Boolean);
        for (const n of names) {
            if (!n || n.length > 32 || n.includes('/')) error(400, `标签名非法：${n}`);
        }
        try {
            setDocTags(locals.user.id, params.id, names);
        } catch (e) {
            if (e instanceof SetTagsError) error(404, '文档不存在或无权操作');
            throw e;
        }
        return { ok: true };
    }
};
