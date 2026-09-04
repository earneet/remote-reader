import { S3ObjectStore } from './object-store-s3';

export interface ObjectStore {
    put(key: string, content: string): Promise<void>;
    get(key: string): Promise<string>;
    delete(key: string): Promise<void>;
}

// 远端对象缺失（语义对齐 storage.ts 的 FileNotFoundError → 路由层 404）
export class ObjectNotFoundError extends Error {
    readonly code = 'ARCHIVE_OBJECT_NOT_FOUND' as const;
    constructor(key: string) {
        super(`archived object not found: ${key}`);
        this.name = 'ObjectNotFoundError';
    }
}

// 远端不可达/未配置（路由层 → 503）
export class ArchiveUnavailableError extends Error {
    readonly code = 'ARCHIVE_UNAVAILABLE' as const;
    constructor(message: string, options?: { cause: unknown }) {
        super(message);
        this.name = 'ArchiveUnavailableError';
        if (options && 'cause' in options) this.cause = options.cause;
    }
}

// 对象 key：docId 维度（删除无引用计数）+ contentHash 后缀（覆盖上传换 key、同内容重传幂等）
export function objectKeyFor(doc: { ownerId: string; id: string; contentHash: string | null }): string {
    return `archive/${doc.ownerId}/${doc.id}-${doc.contentHash ?? 'nohash'}.md`;
}

export type ObjectStoreConfig = {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
};

const ENV_KEYS = [
    'OBJECT_STORE_ENDPOINT',
    'OBJECT_STORE_REGION',
    'OBJECT_STORE_BUCKET',
    'OBJECT_STORE_ACCESS_KEY_ID',
    'OBJECT_STORE_SECRET_ACCESS_KEY'
] as const;

// 全部留空 → null（分层关闭）；任一已配置但组合不完整 → 抛错（确定性配置错误，fail-fast）
export function parseObjectStoreEnv(env: NodeJS.ProcessEnv = process.env): ObjectStoreConfig | null {
    const vals: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) vals[k] = env[k];
    const anySet = Object.values(vals).some((v) => v !== undefined && v !== '');
    if (!anySet) return null;
    const missing = Object.entries(vals).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
        throw new Error(
            `对象存储配置不完整：已设置部分 OBJECT_STORE_* 变量但缺少 ${missing.join(', ')}（要么全部留空关闭分层，要么全部提供）`
        );
    }
    return {
        endpoint: vals.OBJECT_STORE_ENDPOINT!,
        region: vals.OBJECT_STORE_REGION!,
        bucket: vals.OBJECT_STORE_BUCKET!,
        accessKeyId: vals.OBJECT_STORE_ACCESS_KEY_ID!,
        secretAccessKey: vals.OBJECT_STORE_SECRET_ACCESS_KEY!,
        forcePathStyle: env.OBJECT_STORE_FORCE_PATH_STYLE === 'true'
    };
}

let cached: ObjectStore | null | undefined;

export function getObjectStore(): ObjectStore | null {
    if (cached === undefined) {
        const config = parseObjectStoreEnv();
        cached = config === null ? null : new S3ObjectStore(config);
    }
    return cached;
}

// 仅供测试：覆写/重置单例
export function __setObjectStoreForTest(store: ObjectStore | null | undefined): void {
    cached = store;
}

// 测试 fake：内存实现 + 失败注入（崩溃窗口测试用）
export class MemoryObjectStore implements ObjectStore {
    readonly data = new Map<string, string>();
    failPut = false;
    failGet = false;
    failDelete = false;
    async put(key: string, content: string): Promise<void> {
        if (this.failPut) throw new ArchiveUnavailableError(`put ${key} 失败（测试注入）`);
        this.data.set(key, content);
    }
    async get(key: string): Promise<string> {
        if (this.failGet) throw new ArchiveUnavailableError(`get ${key} 失败（测试注入）`);
        const v = this.data.get(key);
        if (v === undefined) throw new ObjectNotFoundError(key);
        return v;
    }
    async delete(key: string): Promise<void> {
        if (this.failDelete) throw new ArchiveUnavailableError(`delete ${key} 失败（测试注入）`);
        this.data.delete(key);
    }
}
