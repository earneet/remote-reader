import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { searchDocuments, SEARCH_LIMIT } from '$server/search';
import { listTags } from '$server/tags';

export const load: PageServerLoad = async ({ locals, url }) => {
    if (!locals.user) redirect(302, '/login');
    const q = url.searchParams.get('q') ?? '';
    const tag = url.searchParams.getAll('tag');
    const results = searchDocuments(locals.user.id, q, tag);
    return {
        results,
        q,
        selectedTags: tag,
        allTags: listTags(locals.user.id),
        truncated: results.length >= SEARCH_LIMIT
    };
};
