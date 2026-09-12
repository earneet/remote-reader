import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { markOwnerViewed } from '$server/documents';

// 「最近浏览」写入侧（spec §6.1）：查看页 onMount 上报；认证与 owner 校验都在服务端。
// 404 不泄露存在性（与库内既有口径一致）；成功 204 无 body。
export const POST: RequestHandler = async ({ locals, params }) => {
    if (!locals.user) error(401, 'unauthorized');
    if (!markOwnerViewed(locals.user.id, params.id)) error(404, 'not found');
    return new Response(null, { status: 204 });
};
