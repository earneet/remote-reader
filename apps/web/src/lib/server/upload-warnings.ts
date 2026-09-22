import { and, eq } from 'drizzle-orm';
import { db, schema } from './db';
import { extractLocalImageSrcs, normalizeImageRef, decodeLocalSrc } from '@remote-reader/shared/image-extract';

// warnings 消息里最多列出的引用数（防超长消息刷屏 Agent 对话）
const MAX_REFS_IN_WARNING = 5;

/** 检测「疑似未随文档上传的本地图片引用」（Layer ②，兜住不发 UA 的旧桥）：
 *  extractLocalImageSrcs 单源提取本地引用，剔除该文档已登记（image_refs JOIN images）的裸名后，
 *  剩余即为可疑——旧桥 `imgs/red.png` 归一化为 null（非裸名）恒可疑；旧桥裸 `red.png`
 *  无对应图行时不在登记集合同样可疑。total 为全量计数（warnings 文案如实报总数），
 *  listed 为解码展示形态、截断 5 条（防超长消息刷屏 Agent 对话）。 */
export function detectUnuploadedLocalImageRefs(ownerId: string, docId: string, content: string): { total: number; listed: string[] } {
    const refs = extractLocalImageSrcs(content);
    if (refs.length === 0) return { total: 0, listed: [] };
    const registered = new Set(
        db.select({ name: schema.images.name })
            .from(schema.imageRefs)
            .innerJoin(schema.images, eq(schema.imageRefs.imageId, schema.images.id))
            .where(and(eq(schema.imageRefs.documentId, docId), eq(schema.images.ownerId, ownerId)))
            .all()
            .map((r) => r.name)
    );
    const suspicious: string[] = [];
    for (const raw of refs) {
        const n = normalizeImageRef(raw);
        if (n && registered.has(n)) continue;
        suspicious.push(decodeLocalSrc(raw));
    }
    return { total: suspicious.length, listed: suspicious.slice(0, MAX_REFS_IN_WARNING) };
}
