import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listChildren, listFolders } from '$server/documents';

export const load: PageServerLoad = async ({ locals, url }) => {
    if (!locals.user) redirect(302, '/login');
    const dir = url.searchParams.get('dir');
    const parentId = dir && dir.length > 0 ? dir : null;
    const children = listChildren(locals.user.id, parentId);
    const folders = listFolders(locals.user.id);
    return { children, folders, currentDir: parentId };
};
