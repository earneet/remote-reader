import type { ObjectStore, ObjectStoreConfig } from './object-store';
import { S3BlobStore } from './blobstore-s3';

// mapGetError 已迁 object-store-errors.ts（叶子模块），此处 re-export 保持既有 import 零改动
export { mapGetError } from './object-store-errors';

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
