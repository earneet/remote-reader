import { and, eq } from 'drizzle-orm';
import { db, schema } from './db';
import { extractUploadSignals, normalizeImageRef, decodeLocalSrc } from '@remote-reader/shared/image-extract';

// warnings 消息里最多列出的引用数（防超长消息刷屏 Agent 对话）
const MAX_REFS_IN_WARNING = 5;

/** 上传内容问题检测单入口（Layer ②）：一次 parse 双 walk（见 extractUploadSignals——两个检测
 *  各自 parse 会把 5MB 上限文档的事件循环阻塞翻倍）。
 *  - images：疑似未随文档上传的本地图片引用（兜住不发 UA 的旧桥）——剔除该文档已登记
 *    （image_refs JOIN images）的裸名后剩余即为可疑；旧桥 `imgs/red.png` 归一化为 null（非裸名）
 *    恒可疑。total 为全量计数（文案如实报总数），listed 为解码展示形态、截 5 条。
 *  - anchors：手写 HTML 锚点（<a id/name=…>，直/弯引号）——html:false 下按原文转义显示、文档内
 *    #fragment 链接落空（2026-09-28 事故）。与图片检测的受众差异：图片 warning 兜旧桥、锚点
 *    warning 面向全部桥版本——桥不预处理锚点，修正责任在内容生产侧（Agent 改用标题自动锚点后
 *    重传，幂等覆盖链接不变）。 */
export function detectUploadIssues(
    ownerId: string,
    docId: string,
    content: string
): { images: { total: number; listed: string[] }; anchors: { total: number; listed: string[] } } {
    const { imageSrcs, anchorIds } = extractUploadSignals(content);
    const suspicious: string[] = [];
    if (imageSrcs.length > 0) {
        const registered = new Set(
            db.select({ name: schema.images.name })
                .from(schema.imageRefs)
                .innerJoin(schema.images, eq(schema.imageRefs.imageId, schema.images.id))
                .where(and(eq(schema.imageRefs.documentId, docId), eq(schema.images.ownerId, ownerId)))
                .all()
                .map((r) => r.name)
        );
        for (const raw of imageSrcs) {
            const n = normalizeImageRef(raw);
            if (n && registered.has(n)) continue;
            suspicious.push(decodeLocalSrc(raw));
        }
    }
    return {
        images: { total: suspicious.length, listed: suspicious.slice(0, MAX_REFS_IN_WARNING) },
        anchors: { total: anchorIds.length, listed: anchorIds.slice(0, MAX_REFS_IN_WARNING) }
    };
}
