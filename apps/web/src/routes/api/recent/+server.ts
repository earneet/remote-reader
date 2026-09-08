import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { recentFiles } from '$server/documents';
import { listTagsForDocs } from '$server/tags';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 2000; // re-sync 深度上限（spec §5.3，与 §7 性能论证对齐）

export const GET: RequestHandler = async ({ locals, url }) => {
    if (!locals.user) error(401, 'unauthorized');

    let limit = DEFAULT_LIMIT;
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit !== null) {
        if (!/^\d+$/.test(rawLimit)) error(400, 'invalid limit');
        limit = Math.min(Math.max(Number.parseInt(rawLimit, 10), 1), MAX_LIMIT);
    }

    // cursor 格式 <updatedAt>_<id>：id 是 UUID+base36（不含 _），分隔符安全（spec §5.3）
    let cursor: { updatedAt: number; id: string } | null = null;
    const rawBefore = url.searchParams.get('before');
    if (rawBefore !== null) {
        const sep = rawBefore.indexOf('_');
        const tsStr = sep > 0 ? rawBefore.slice(0, sep) : '';
        const id = sep > 0 ? rawBefore.slice(sep + 1) : '';
        if (!/^\d+$/.test(tsStr) || !id) error(400, 'invalid before');
        cursor = { updatedAt: Number.parseInt(tsStr, 10), id };
    }

    const rows = recentFiles(locals.user.id, cursor, limit);
    const tagsByDoc = listTagsForDocs(rows.map((r) => r.id), locals.user.id);
    return json({ items: rows.map((r) => ({ ...r, tags: tagsByDoc.get(r.id) ?? [] })) });
};
