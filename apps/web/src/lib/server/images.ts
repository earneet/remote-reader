import { createHash } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import { db, schema } from './db';
import { generateId } from './auth';
import { getBlobStore, getActiveImageStore } from './blobstore';
import { getMaxImageBytes } from './env';
import { sanitizeImageName } from '@remote-reader/shared/image-mime';

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
