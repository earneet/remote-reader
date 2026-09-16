import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getOwnedDocument } from '$server/documents';
import { getOrCreateShareUrl, revokeAllShares } from '$server/shares';

// FM 行内分享操作（spec 2026-09-16 §4）：session 认证 + owner 校验，404 不泄漏存在性（同 /api/view 口径）。
// POST = get-or-create 活跃链接（与上传幂等「链接长期稳定」同语义）；DELETE = 转为私有（撤销全部链接，幂等）。
export const POST: RequestHandler = async ({ locals, params }) => {
    if (!locals.user) error(401, 'unauthorized');
    const url = await getOrCreateShareUrl(locals.user.id, params.id);
    if (!url) error(404, 'not found');
    return json({ url });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
    if (!locals.user) error(401, 'unauthorized');
    // owner + file 校验（folder 无分享语义）；revokeAllShares 幂等（0 条也 200）
    const doc = getOwnedDocument(params.id, locals.user.id);
    if (!doc || doc.type !== 'file') error(404, 'not found');
    revokeAllShares(locals.user.id, params.id);
    return json({ ok: true });
};
