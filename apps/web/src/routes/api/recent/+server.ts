import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { recentFiles, toDocDTO } from '$server/documents';
import { listTagsForDocs } from '$server/tags';
import { RECENT_PAGE_SIZE, type RecentSort } from '$lib/shared/recent';

const MAX_LIMIT = 2000; // re-sync 深度上限（spec §5.3，与 §7 性能论证对齐）

export const GET: RequestHandler = async ({ locals, url }) => {
    if (!locals.user) error(401, 'unauthorized');

    // sort（spec §6.2）：缺省 updated 向后兼容；非法值 400（同 limit/before 严格风格）
    const rawSort = url.searchParams.get('sort');
    if (rawSort !== null && rawSort !== 'updated' && rawSort !== 'viewed') error(400, 'invalid sort');
    const sort: RecentSort = rawSort === 'viewed' ? 'viewed' : 'updated';

    let limit = RECENT_PAGE_SIZE;
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit !== null) {
        if (!/^\d+$/.test(rawLimit)) error(400, 'invalid limit');
        limit = Math.min(Math.max(Number.parseInt(rawLimit, 10), 1), MAX_LIMIT);
    }

    // cursor 格式 <ts>_<id>：ts 语义按 sort 解释（updated → updated_at，viewed → owner_viewed_at）；
    // id 是 UUID+base36（不含 _），分隔符安全（spec §5.3）
    let cursor: { ts: number; id: string } | null = null;
    const rawBefore = url.searchParams.get('before');
    if (rawBefore !== null) {
        const sep = rawBefore.indexOf('_');
        const tsStr = sep > 0 ? rawBefore.slice(0, sep) : '';
        const id = sep > 0 ? rawBefore.slice(sep + 1) : '';
        if (!/^\d+$/.test(tsStr) || !id) error(400, 'invalid before');
        cursor = { ts: Number.parseInt(tsStr, 10), id };
    }

    const rows = recentFiles(locals.user.id, sort, cursor, limit);
    const tagsByDoc = listTagsForDocs(rows.map((r) => r.id), locals.user.id);
    return json({ items: rows.map((r) => ({ ...toDocDTO(r), tags: tagsByDoc.get(r.id) ?? [] })) });
};
