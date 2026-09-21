import { createHash } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { db, schema } from './db';
import { generateId } from './auth';
import { getBlobStore, getActiveImageStore } from './blobstore';
import { getMaxImageBytes } from './env';
import { sanitizeImageName, detectImageMime } from '@remote-reader/shared/image-mime';
import { ObjectNotFoundError } from './object-store';

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
        if (byHash?.status === 'ready') return { status: 'exists', name: byHash.name };
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
        return { ok: false, reason: 'invalid', message: isSvg ? '不支持的图片格式（SVG 可携脚本，安全考虑不支持；支持 png/jpeg/gif/webp）' : '无法识别的图片格式（支持 png/jpeg/gif/webp）' };
    }
    const ext = row.name.split('.').pop()?.toLowerCase() ?? '';
    const allowedExts: Record<string, string[]> = {
        'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/gif': ['gif'], 'image/webp': ['webp']
    };
    if (!(allowedExts[mime] ?? []).includes(ext)) {
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
    if (mime === null) return { ok: false, reason: 'invalid', message: '对象内容非支持图片格式' };
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
