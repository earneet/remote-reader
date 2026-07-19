import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getOwnedDocument } from '$server/documents';
import { readFile } from '$server/storage';
import { renderMarkdown } from '$server/markdown';

export const load: PageServerLoad = async ({ locals, params }) => {
    if (!locals.user) redirect(302, '/login');
    const doc = getOwnedDocument(params.id, locals.user.id);
    if (!doc || doc.type !== 'file' || !doc.storagePath) error(404, '文档不存在');
    const content = await readFile(doc.storagePath);
    const html = await renderMarkdown(content);
    return { title: doc.name, html };
};
