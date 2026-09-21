import { resolveImageByName } from './images';
import { getBlobStore } from './blobstore';
import { getImageSignedUrlTtl, getImageProxyAll } from './env';
import { lazyRegisterRefs } from './image-refs';
import { MAX_IMAGE_REFS } from '@remote-reader/shared/image-extract';

export type ResolveCtx =
    | { kind: 'share'; token: string; ownerId: string; docId: string; contentHash: string }
    | { kind: 'owner'; ownerId: string; docId: string; contentHash: string };

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// presign URL 桶缓存（spec §7.3 桶对齐）：同桶内复用首签 URL（逐字节相同 → 浏览器缓存命中）。
// 不依赖 SDK signingDate——用结果缓存；expiresIn = TTL + 桶宽 保证桶末仍有效（envTtl 语义=最短有效期）。
// 并发 miss 允许短暂双 URL（SigV4 本地 HMAC，microtask 窗口真实存在；两 URL 均有效，桶内后续稳定，
// 仅一次浏览器缓存不命中）——刻意不加锁，后人勿当 bug 修。
const presignCache = new Map<string, { bucket: number; url: string }>();
const PRESIGN_CACHE_MAX = 256;

// 仅供测试：清空桶缓存（桶对齐确定性测试前置）
export function __resetPresignCacheForTest(): void {
    presignCache.clear();
}

/** 替换阶段（每请求执行，缓存命中也走到，spec §7.2）：占位符 → 最终 URL/裂图占位 + refs 惰性补录 */
export async function resolveImages(html: string, names: string[], ctx: ResolveCtx): Promise<string> {
    // 数量超限防御（交叉审查 P0，防存量/绕过）：下方逐名循环是 O(N×|html|)+O(N) 查询——
    // 超限文档整体降级为单趟正则替换，跳过逐名解析与 refs 补录，免登录页零放大
    if (names.length > MAX_IMAGE_REFS) {
        const span = `<span class="rr-img-missing" title="图片引用超过上限 ${MAX_IMAGE_REFS}，图片渲染已停用">🖼 [图片引用过多，请拆分文档]</span>`;
        const re = new RegExp(`<img[^>]*%%RR:IMG:${ctx.contentHash.slice(0, 8)}:\\d+%%[^>]*>`, 'g');
        return html.replace(re, () => span);
    }
    const ttl = getImageSignedUrlTtl();
    const bucketMs = (ttl * 1000) / 6;
    const bucket = Math.floor(Date.now() / bucketMs);
    const proxyAll = getImageProxyAll();
    const urls: string[] = [];
    for (const name of names) {
        const row = resolveImageByName(ctx.ownerId, name);
        if (!row) {
            urls.push(`<span class="rr-img-missing" title="图片不存在或未就绪">🖼 [${escapeHtml(name)}]</span>`);
            continue;
        }
        const store = getBlobStore(row.storageBackend);
        if (!store) {
            urls.push(`<span class="rr-img-missing" title="图暂不可用：存储后端已移除（503）">🖼 [${escapeHtml(name)}]</span>`);
            continue;
        }
        // URL 决策树（spec §7.3）：强制代理 | local | 无 presign 能力（L0 插件兜底）→ 代理路由；
        // s3 + presign → 桶对齐直连。referrerpolicy 已在渲染期预置（Task 3），此处只换 URL。
        const canPresign = !proxyAll && row.storageBackend === 's3' && store.presign !== undefined;
        if (!canPresign) {
            const base = ctx.kind === 'share' ? `/s/${ctx.token}/i/` : `/d/${ctx.docId}/i/`;
            urls.push(`${base}${encodeURIComponent(name)}`);
            continue;
        }
        const cached = presignCache.get(row.id);
        if (cached && cached.bucket === bucket) {
            urls.push(cached.url);
            continue;
        }
        // canPresign 已含 store.presign !== undefined——TS 不跨中间布尔收窄，断言兜底（同 defaultImage! 先例）
        const url = await store.presign!('get', row.storageKey, ttl + Math.ceil(bucketMs / 1000));
        if (presignCache.size >= PRESIGN_CACHE_MAX) {
            const first = presignCache.keys().next().value;
            if (first !== undefined) presignCache.delete(first);
        }
        presignCache.set(row.id, { bucket, url });
        urls.push(url);
    }
    // refs 惰性补录（P1-4 content-hash 守卫在 lazyRegisterRefs 内部）：批量单事务
    lazyRegisterRefs(ctx.ownerId, ctx.docId, ctx.contentHash, names);
    // 逐占位符替换（contentHash 前 8 自指防冲突）。双轨（P0-1）：
    //  - URL（代理/presign）：占位符在 src 属性值内，split/join 只换值——安全
    //  - 裂图 span：必须吃掉整个 <img> 标签——span 塞进 src 值会被内部引号截断属性、
    //    alt/loading/decoding 泄漏为可见文本（HTML 结构破坏）。正则匹配含占位符的整标签：
    //    占位符仅含 hex/冒号/%%（非正则元字符），markdown-it 转义 alt 保证标签体内无裸 >，
    //    [^>]* 安全；'g' 覆盖同图多引用
    let out = html;
    for (let n = 0; n < names.length; n++) {
        const ph = `%%RR:IMG:${ctx.contentHash.slice(0, 8)}:${n}%%`;
        const replacement = urls[n];
        if (replacement.startsWith('<span')) {
            // 替换串走函数形式：裂图 span 内嵌用户可控 name，`$&`/`$1` 等 $ 模式会被
            // String.replace 替换串语义解释（name="a$&b.png" 合法 → 整个 img 标签被展开进文本）
            out = out.replace(new RegExp(`<img[^>]*${ph}[^>]*>`, 'g'), () => replacement);
        } else {
            out = out.split(ph).join(replacement);
        }
    }
    return out;
}
