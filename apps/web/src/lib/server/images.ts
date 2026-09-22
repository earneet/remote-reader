import { createHash } from 'node:crypto';
import { error } from '@sveltejs/kit';
import { and, eq, ne } from 'drizzle-orm';
import { db, schema } from './db';
import { generateId } from './auth';
import { getBlobStore, getActiveImageStore } from './blobstore';
import { getMaxImageBytes } from './env';
import { sanitizeImageName, detectImageMime, extsForMime } from '@remote-reader/shared/image-mime';
import { ObjectNotFoundError, ArchiveUnavailableError } from './object-store';
import { deleteBlobIfOrphaned } from './image-refs';

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const NAME_SUFFIX_LIMIT = 16;

export type InitImageInput = { name: string; contentHash: string; contentMd5: string; sizeBytes: number };
export type InitImageResult =
    | { status: 'exists'; name: string }
    | { status: 'relay'; name: string; imageId: string }
    | { status: 'direct'; name: string; imageId: string; uploadUrl: string };

export class ImageInputError extends Error {
    constructor(message: string, public status: 400 | 409 | 413) { super(message); this.name = 'ImageInputError'; }
}

function validateInitInput(input: InitImageInput): void {
    if (!HEX64.test(input.contentHash)) throw new ImageInputError('content_hash 须为 64 位小写 hex', 400); // P0-1：防 storage_key 路径穿越
    if (!HEX32.test(input.contentMd5)) throw new ImageInputError('content_md5 须为 32 位小写 hex', 400);
    if (typeof input.sizeBytes !== 'number' || input.sizeBytes < 0) throw new ImageInputError('size_bytes 非法', 400);
    if (input.sizeBytes > getMaxImageBytes()) throw new ImageInputError(`图片超过上限（${getMaxImageBytes()}B）`, 413);
    const name = sanitizeImageName(input.name);
    if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..'
        || /[\x00-\x1f]/.test(name) || Buffer.byteLength(name, 'utf8') > 255) {
        throw new ImageInputError('name 须为单段合法文件名', 400);
    }
}

/** 名字分配：请求名可用直接用；被占（任何 status 的行——墓碑占位是特性）则后缀 -2..-16 精确探测。
 *  excludeId：复活场景排除自身行（P0-1：不排除则墓碑的现存名被自己"占用"，同名重传被强制 -2 改名 →
 *  裸名引用断裂 → 无 refs 二次 GC 丢数据） */
function allocateName(ownerId: string, requested: string, excludeId?: string): string {
    const taken = (n: string): boolean =>
        db.select({ id: schema.images.id }).from(schema.images)
            .where(and(
                eq(schema.images.ownerId, ownerId),
                eq(schema.images.name, n),
                excludeId === undefined ? undefined : ne(schema.images.id, excludeId)
            )).get() !== undefined;
    if (!taken(requested)) return requested;
    const dot = requested.lastIndexOf('.');
    const base = dot > 0 ? requested.slice(0, dot) : requested;
    const ext = dot > 0 ? requested.slice(dot) : '';
    for (let i = 2; i < 2 + NAME_SUFFIX_LIMIT; i++) {
        let cand = `${base}-${i}${ext}`;
        if (Buffer.byteLength(cand, 'utf8') > 255) cand = `${base.slice(0, base.length - 4)}-${i}${ext}`;
        if (!taken(cand)) return cand;
    }
    throw new ImageInputError(`"${requested}" 的同名后缀已达上限（${NAME_SUFFIX_LIMIT}）`, 409);
}

function storageKeyFor(backend: string, ownerId: string, hash: string): string {
    return backend === 's3' ? `images/${ownerId}/${hash}` : `${ownerId}/blobs/${hash.slice(0, 2)}/${hash}`;
}

export async function initImage(ownerId: string, input: InitImageInput): Promise<InitImageResult> {
    validateInitInput(input);
    const active = getActiveImageStore();
    const now = Date.now();
    for (let attempt = 0; ; attempt++) {
        if (attempt >= 4) throw new ImageInputError('init 并发冲突重试次数超限，请重试', 409);
        const byHash = db.select().from(schema.images)
            .where(and(eq(schema.images.ownerId, ownerId), eq(schema.images.contentHash, input.contentHash))).get();
        if (byHash?.status === 'ready') {
            // blob 丢失自愈（交叉审查 P1）：行 ready 但物理 blob 不在（磁盘损坏/误删）时若仍报 exists，
            // 重传永远命中 exists → 裂图永续。head 探测丢失 → 降级墓碑（复用 GC 软删语义）→ continue
            // 走复活重传。上传路径非渲染热路径，每图一次 head 可接受；探测自身故障（不可达）不阻断幂等快路径。
            const store = getBlobStore(byHash.storageBackend);
            if (store?.head) {
                try {
                    await store.head(byHash.storageKey);
                } catch (e) {
                    if (e instanceof ObjectNotFoundError) {
                        db.update(schema.images).set({ status: 'deleted' })
                            .where(and(eq(schema.images.id, byHash.id), eq(schema.images.status, 'ready'))).run();
                        continue;
                    }
                }
            }
            return { status: 'exists', name: byHash.name };
        }
        if (byHash && (byHash.status === 'pending' || byHash.status === 'deleted')) {
            const rowId = byHash.id;
            if (byHash.status === 'deleted') {
                // 墓碑复活（P0-1）：请求名 == 行名（同名重传，主场景）直接沿用原名；别名重传排除自身行分配
                const wanted = sanitizeImageName(input.name);
                const keepName = wanted === byHash.name ? byHash.name : allocateName(ownerId, wanted, byHash.id);
                const revived = db.update(schema.images).set({
                    status: 'pending', name: keepName,
                    contentMd5: input.contentMd5, sizeBytes: input.sizeBytes,
                    storageBackend: active.id, storageKey: storageKeyFor(active.id, ownerId, input.contentHash),
                    createdAt: now, readyAt: null
                }).where(and(eq(schema.images.id, byHash.id), eq(schema.images.status, 'deleted'))).run().changes > 0;
                if (!revived) continue;
            }
            return await directOrRelay(rowId);
        }
        const name = allocateName(ownerId, sanitizeImageName(input.name));
        const id = generateId();
        try {
            db.insert(schema.images).values({
                id, ownerId, name, contentHash: input.contentHash, contentMd5: input.contentMd5,
                mimeType: 'image/png', // 占位：relay/confirm 验证后按实际魔数回写
                sizeBytes: input.sizeBytes, status: 'pending',
                storageBackend: active.id, storageKey: storageKeyFor(active.id, ownerId, input.contentHash),
                createdAt: now, readyAt: null
            }).run();
        } catch (e) {
            if (e instanceof Error && (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') continue;
            throw e;
        }
        return await directOrRelay(id);
    }
}

/** 按行的 storage_backend 决定 direct/relay——行内后端优先于 active（共享行可能属旧后端） */
async function directOrRelay(imageId: string): Promise<InitImageResult> {
    const row = db.select().from(schema.images).where(eq(schema.images.id, imageId)).get()!;
    const store = getBlobStore(row.storageBackend);
    if (store?.presign && store.id === 's3') {
        const uploadUrl = await store.presign('put', row.storageKey, store.uploadUrlTtlSeconds ?? 600);
        return { status: 'direct', name: row.name, imageId: row.id, uploadUrl };
    }
    return { status: 'relay', name: row.name, imageId: row.id };
}

/** 条件式删除注定无法 ready 的 pending 行（relay 的 magic/ext 失败、confirm 的 magic/ext 失败且 ETag 已证内容诚实）。
 *  不变量：sha256（relay）/ ETag==md5（confirm）已绑定内容真值，其后 magic/ext 失败对 (name,content) 是永久性的
 *  （内容 hash 不可变、校验确定性）——该行永远无法 ready，占着 (owner,hash) 唯一键与名字只会制造改名重传死锁
 *  （initImage 复用 pending 行返回行内注册名，spec §4.4）。删行释放 (owner,hash) 与名字，下次 init 走新建
 *  分支用修正后的名字。pending 行正常路径无 refs 指向（refs 只登记 ready 行），DELETE image_refs 仅防历史
 *  悬空坏态（image_refs.image_id FK 是 no action 且 foreign_keys=ON，不先清会让 DELETE 抛 FK 错误）。 */
function dropDoomedPendingRow(rowId: string): void {
    db.transaction((tx) => {
        tx.delete(schema.imageRefs).where(eq(schema.imageRefs.imageId, rowId)).run();
        tx.delete(schema.images).where(and(eq(schema.images.id, rowId), eq(schema.images.status, 'pending'))).run();
    });
}

export type RelayResult = { ok: true; name: string } | { ok: false; reason: 'missing' } | { ok: false; reason: 'invalid'; message: string };

export async function relayImage(ownerId: string, imageId: string, data: Buffer): Promise<RelayResult> {
    const row = db.select().from(schema.images).where(and(eq(schema.images.id, imageId), eq(schema.images.ownerId, ownerId))).get();
    if (!row) return { ok: false, reason: 'missing' };
    if (row.status === 'ready') return { ok: true, name: row.name };
    if (row.status !== 'pending') return { ok: false, reason: 'missing' };
    // 实测大小（spec §5.2 校验链第二环，P1-1）：init 报称 size 可谎报绕过预检，此处按真实字节拦截
    if (data.length > getMaxImageBytes()) {
        return { ok: false, reason: 'invalid', message: `图片实际大小 ${data.length}B 超过上限 ${getMaxImageBytes()}B` };
    }
    const actualHash = createHash('sha256').update(data).digest('hex');
    if (actualHash !== row.contentHash) return { ok: false, reason: 'invalid', message: '内容 hash 与 init 报称不符（去重池完整性拒绝）' };
    const mime = detectImageMime(data);
    if (mime === null) {
        const isSvg = data.subarray(0, 5).toString('latin1').startsWith('<');
        // sha256 已绑定内容真值：非支持格式对该内容永久成立 → 删行释放 (owner,hash)，封死改名重传死锁
        dropDoomedPendingRow(row.id);
        return { ok: false, reason: 'invalid', message: isSvg ? '不支持的图片格式（SVG 可携脚本，安全考虑不支持；支持 png/jpeg/gif/webp）' : '无法识别的图片格式（支持 png/jpeg/gif/webp）' };
    }
    const ext = row.name.split('.').pop()?.toLowerCase() ?? '';
    if (!extsForMime(mime).includes(ext)) {
        // 同上：字节真值已定且格式可辨，(name,content) 错配永久成立 → 删行，下次 init 用修正后的名字
        dropDoomedPendingRow(row.id);
        return { ok: false, reason: 'invalid', message: `扩展名 .${ext} 与实际格式 ${mime} 不一致，请改名重传` };
    }
    const store = getBlobStore(row.storageBackend);
    if (!store) return { ok: false, reason: 'invalid', message: '存储后端不可用' };
    await store.put(row.storageKey, data, mime);
    const flipped = db.update(schema.images).set({
        status: 'ready', readyAt: Date.now(), mimeType: mime, sizeBytes: data.length
    }).where(and(eq(schema.images.id, row.id), eq(schema.images.status, 'pending'))).run().changes > 0;
    if (!flipped) {
        const recheck = db.select().from(schema.images).where(eq(schema.images.id, row.id)).get();
        if (recheck?.status === 'ready') return { ok: true, name: recheck.name };
        return { ok: false, reason: 'missing' };
    }
    return { ok: true, name: row.name };
}

export type ConfirmResult = { ok: true; name: string } | { ok: false; reason: 'missing' } | { ok: false; reason: 'invalid'; message: string };

export async function confirmImage(ownerId: string, imageId: string): Promise<ConfirmResult> {
    const row = db.select().from(schema.images).where(and(eq(schema.images.id, imageId), eq(schema.images.ownerId, ownerId))).get();
    if (!row) return { ok: false, reason: 'missing' };
    if (row.status === 'ready') return { ok: true, name: row.name };
    if (row.status !== 'pending') return { ok: false, reason: 'missing' };
    const store = getBlobStore(row.storageBackend);
    if (!store || !store.head || !store.getRange) return { ok: false, reason: 'invalid', message: '存储后端不支持验证（需 head/getRange 能力）' };
    let head: { size: number; etag?: string };
    try {
        head = await store.head(row.storageKey);
    } catch (e) {
        if (e instanceof ObjectNotFoundError) return { ok: false, reason: 'missing' };
        throw e; // ArchiveUnavailable → 路由层 503
    }
    if (head.size > getMaxImageBytes()) return { ok: false, reason: 'invalid', message: '对象超过大小上限' };
    const head32 = await store.getRange(row.storageKey, 0, 31);
    const mime = detectImageMime(head32);
    if (mime === null) {
        // ETag==md5 已证字节诚实 → 非支持格式对该内容永久成立 → 删 pending 行防死锁；ETag 缺失/不符 → 行可能是无辜的，不删
        if (head.etag !== undefined && head.etag === row.contentMd5) {
            dropDoomedPendingRow(row.id);
            // direct 通道对象已 PUT 到云：行删后无任何回收路径 → 反查式删孤儿（relay 路径字节从未落盘，drop 在 put 之前，无需处理）
            void deleteBlobIfOrphaned(row.storageBackend, row.storageKey);
        }
        return { ok: false, reason: 'invalid', message: '对象内容非支持图片格式' };
    }
    // 扩展名一致（spec §5.3/§11 与 relay 双重承诺）：direct 通道 PUT 的字节格式须与 init 名字匹配；
    // 不删云对象（key 内容寻址，重传覆盖消化——与「无行孤儿 blob」备案一致）。
    // ETag==md5 已证字节诚实 → (name,content) 错配永久成立 → 同款删行封死死锁；ETag 缺失/不符不删（行可能是无辜的）
    const ext = row.name.split('.').pop()?.toLowerCase() ?? '';
    if (!extsForMime(mime).includes(ext)) {
        if (head.etag !== undefined && head.etag === row.contentMd5) {
            dropDoomedPendingRow(row.id);
            // 同上 magic-null：direct 通道孤儿对象反查式回收
            void deleteBlobIfOrphaned(row.storageBackend, row.storageKey);
        }
        return { ok: false, reason: 'invalid', message: `扩展名 .${ext} 与实际格式 ${mime} 不一致，请改名重传` };
    }
    if (head.etag !== undefined && head.etag !== row.contentMd5) {
        try { await store.delete(row.storageKey); } catch { /* 留孤儿，无害 */ }
        return { ok: false, reason: 'invalid', message: '内容 md5 与 init 报称不符（ETag 校验失败）' };
    }
    const flipped = db.update(schema.images).set({
        status: 'ready', readyAt: Date.now(), mimeType: mime, sizeBytes: head.size
    }).where(and(eq(schema.images.id, row.id), eq(schema.images.status, 'pending'))).run().changes > 0;
    if (!flipped) {
        const recheck = db.select().from(schema.images).where(eq(schema.images.id, row.id)).get();
        if (recheck?.status === 'ready') return { ok: true, name: recheck.name };
        return { ok: false, reason: 'missing' };
    }
    return { ok: true, name: row.name };
}

export function resolveImageByName(ownerId: string, name: string): { id: string; storageBackend: string; storageKey: string; mimeType: string; contentHash: string } | null {
    return db.select({
        id: schema.images.id, storageBackend: schema.images.storageBackend,
        storageKey: schema.images.storageKey, mimeType: schema.images.mimeType,
        contentHash: schema.images.contentHash
    }).from(schema.images)
        .where(and(eq(schema.images.ownerId, ownerId), eq(schema.images.name, name), eq(schema.images.status, 'ready')))
        .get() ?? null;
}

/** 图片代理响应（/s/[token]/i/[name] 与 /d/[id]/i/[name] 的公共段，调用方只负责各自鉴权）：
 *  refs 白名单（spec #8：该 md 必须引用此图——share token 不能枚举 owner 其他图）→
 *  no-cache 协商（spec #26：ETag=content_hash，If-None-Match 命中 → 304 无 body，头在 Response 上）→
 *  取字节 → 错误三分类（blob 缺失 404 / 后端未注册 503 / 存储不可达 503）。 */
export async function serveImageResponse({ request, setHeaders, ownerId, documentId, name }: {
    request: Request;
    setHeaders: (headers: Record<string, string>) => void;
    ownerId: string;
    documentId: string;
    name: string;
}): Promise<Response> {
    const img = resolveImageByName(ownerId, name);
    if (!img) error(404, 'Not Found');
    const refed = db.select({ x: schema.imageRefs.documentId }).from(schema.imageRefs)
        .where(eq(schema.imageRefs.imageId, img.id)).all().some((r) => r.x === documentId);
    if (!refed) error(404, 'Not Found');
    const etag = `"${img.contentHash}"`;
    if (request.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache' } });
    }
    const store = getBlobStore(img.storageBackend);
    if (!store) error(503, 'image backend unavailable');
    let data: Buffer;
    try {
        data = await store.get(img.storageKey);
    } catch (e) {
        if (e instanceof ObjectNotFoundError) error(404, 'Not Found');
        if (e instanceof ArchiveUnavailableError) error(503, 'image storage unreachable');
        throw e;
    }
    setHeaders({
        'Content-Type': img.mimeType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
        ETag: etag
    });
    return new Response(new Uint8Array(data));
}
