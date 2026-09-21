import type { ObjectStore, ObjectStoreConfig } from './object-store';
import { ObjectNotFoundError, ArchiveUnavailableError } from './object-store';
import { S3BlobStore } from './blobstore-s3';

// GET 错误映射：NoSuchKey / HTTP 404 → 对象缺失（404 语义）；其余 → 不可达（503 语义）
// 404 兜底：部分 S3 兼容网关对缺失对象返回非标准错误体（无 NoSuchKey Code），按状态码归类
export function mapGetError(key: string, e: unknown): Error {
    if ((e as { name?: string }).name === 'NoSuchKey') return new ObjectNotFoundError(key);
    if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
        return new ObjectNotFoundError(key);
    }
    return new ArchiveUnavailableError(`get ${key} 失败`, { cause: e });
}

// 冷档存储适配器（Phase 5 收敛）：string 语义（markdown 文本）转调 S3BlobStore 的字节语义，
// string↔Buffer 转换收在本层；S3Client 构建/NodeHttpHandler 超时/重试配置单源在 S3BlobStore。
// （错误消息前缀随转调变为 "blob put/get/delete ..."——异常类型与 404/503 语义不变）
export class S3ObjectStore implements ObjectStore {
    private readonly store: S3BlobStore;

    constructor(config: ObjectStoreConfig) {
        this.store = new S3BlobStore(config);
    }

    async put(key: string, content: string): Promise<void> {
        // ContentType 显式传（P2-5）：不传会落 S3BlobStore 默认的 octet-stream，冷档对象元数据漂移
        await this.store.put(key, Buffer.from(content), 'text/markdown; charset=utf-8');
    }

    async get(key: string): Promise<string> {
        return (await this.store.get(key)).toString('utf-8');
    }

    async delete(key: string): Promise<void> {
        await this.store.delete(key);
    }
}
