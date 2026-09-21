import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getDocumentIdByShareToken } from '$server/shares';
import { getDocumentById, readDocumentContent } from '$server/documents';
import { FileNotFoundError } from '$server/storage';
import { ArchiveUnavailableError, ObjectNotFoundError } from '$server/object-store';
import { renderMarkdown } from '$server/markdown';

export const load: PageServerLoad = async ({ locals, params, setHeaders }) => {
    const documentId = getDocumentIdByShareToken(params.token);
    if (!documentId) error(404, '链接已失效或不存在');

    const doc = getDocumentById(documentId);
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
    // M1: 免登录查看页禁缓存——撤销 share token 后浏览器/CDN/bfcache 不再展示已撤销内容
    setHeaders({ 'cache-control': 'no-store' });
    // 「最近浏览」写入侧（spec §7.1）：owner 登录态打开分享链接也算一次浏览——
    // hooks 全局解析 session，/s/ 免登录特性不变（无 session → ownerView=false，客户端不上报）
    return { id: doc.id, ownerView: locals.user?.id === doc.ownerId, title: doc.name, html };
};
