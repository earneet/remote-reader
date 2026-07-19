import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getOwnedDocument } from '$server/documents';
import { readFile, FileNotFoundError } from '$server/storage';
import { renderMarkdown } from '$server/markdown';

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
    setHeaders({ 'cache-control': 'no-store' });
    return { title: doc.name, html };
};
