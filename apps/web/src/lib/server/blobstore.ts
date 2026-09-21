import { getImageStoreBackend } from './env';
import { parseObjectStoreEnv, type ObjectStoreConfig } from './object-store';
import { LocalBlobStore } from './blobstore-local';
import { S3BlobStore } from './blobstore-s3';

// BlobStore：无状态字节存储插件接口（spec 2026-09-20 §8）。
// 契约：插件只认 key 与字节——mime/size/hash 等元数据全在 DB 行，存储层不理解内容。
// 演进纪律（#27）：只能加可选成员，禁止加必选、禁止删改既有签名；能力用运行时探测（if (store.presign)）。
// key 由核心分配传入：local '<ownerId>/blobs/<h2>/<hash>' / s3 'images/<ownerId>/<hash>'（per-owner 内容寻址）。
// ⚠️ 依赖方向约束：blobstore-local.ts / blobstore-s3.ts 对本文件必须 `import type`（type-only）——
//    值导入会形成 blobstore → blobstore-s3 → blobstore 运行时循环。
export interface BlobStore {
    readonly id: string;
    /** presigned PUT URL 的建议有效期（秒）；慢后端可自声明更长。默认 600 */
    readonly uploadUrlTtlSeconds?: number;
    put(key: string, data: Buffer, contentType?: string): Promise<void>;
    get(key: string): Promise<Buffer>;
    head?(key: string): Promise<{ size: number; etag?: string }>;
    /** 读 [start, end] 闭区间字节（confirm 魔数预判 32B = getRange(key, 0, 31)） */
    getRange?(key: string, start: number, end: number): Promise<Buffer>;
    delete(key: string): Promise<void>;
    presign?(op: 'get' | 'put', key: string, ttlSeconds: number, opts?: Record<string, string>): Promise<string>;
}

// s3 注册条件（P2-7 语义）：OBJECT_STORE_* 配置齐全即注册——即使 IMAGE_STORE_BACKEND=local，
// 旧 s3 行的读取仍能路由到 s3 实现（换后端不炸旧图；彻底删除 env 才会 503，INSTALL 有文档）
function buildRegistry(): Map<string, BlobStore> {
    const m = new Map<string, BlobStore>();
    m.set('local', new LocalBlobStore());
    const s3config = parseObjectStoreEnv();
    if (s3config !== null) {
        m.set('s3', new S3BlobStore(s3config));
    }
    return m;
}

let registry: Map<string, BlobStore> | undefined;

/** 按 id 查已注册插件；未注册返回 null（调用方转 503/裂图占位） */
export function getBlobStore(id: string): BlobStore | null {
    if (registry === undefined) registry = buildRegistry();
    return registry.get(id) ?? null;
}

/** 当前 env 选定的 active 插件（写入路径用）；选了 s3 但未注册 → 抛错（确定性配置错误） */
export function getActiveImageStore(): BlobStore {
    const wanted = getImageStoreBackend();
    const store = getBlobStore(wanted);
    if (store === null) {
        throw new Error(`IMAGE_STORE_BACKEND=${wanted} 但该后端未注册（s3 需 OBJECT_STORE_* 五项配置齐全）`);
    }
    return store;
}

// 仅供测试：覆写/重置注册表（undefined = 下次访问重算）
export function __setBlobStoresForTest(stores: { local: BlobStore; s3?: BlobStore } | undefined): void {
    registry = stores === undefined ? undefined : new Map(Object.entries(stores));
}
