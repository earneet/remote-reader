import {
    S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { ObjectStoreConfig } from './object-store';
import { ObjectNotFoundError, ArchiveUnavailableError } from './object-store';
import { mapGetError } from './object-store-s3';
import type { BlobStore } from './blobstore';

// s3 插件（spec §8）：Buffer 语义 + head/getRange/presign。
// 与现有 S3ObjectStore（string 语义）并存——Phase 5 冷却收敛时迁移消费者后删除旧实现。
// ⚠️ 七牛部署注意（spec §14）：presign 的 Bucket 必须用「S3 空间名」（空间名全局不唯一时七牛自动生成，控制台查）。
export class S3BlobStore implements BlobStore {
    readonly id = 's3';
    readonly uploadUrlTtlSeconds = 600;
    private readonly client: S3Client;
    private readonly bucket: string;

    constructor(config: ObjectStoreConfig) {
        this.client = new S3Client({
            endpoint: config.endpoint,
            region: config.region,
            forcePathStyle: config.forcePathStyle,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey
            },
            // 同 S3ObjectStore 先例：挂起端点快速失败交给 503 语义
            requestHandler: new NodeHttpHandler({ requestTimeout: 5_000 }),
            maxAttempts: 2
        });
        this.bucket = config.bucket;
    }

    async put(key: string, data: Buffer, contentType?: string): Promise<void> {
        try {
            await this.client.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: data,
                ContentType: contentType ?? 'application/octet-stream'
            }));
        } catch (e) {
            throw new ArchiveUnavailableError(`blob put ${key} 失败`, { cause: e });
        }
    }

    async get(key: string): Promise<Buffer> {
        let body: { transformToByteArray(): Promise<Uint8Array> } | undefined;
        try {
            const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
            body = res.Body as { transformToByteArray(): Promise<Uint8Array> };
        } catch (e) {
            throw mapGetError(key, e);
        }
        if (!body) throw new ObjectNotFoundError(key);
        try {
            return Buffer.from(await body.transformToByteArray());
        } catch (e) {
            throw new ArchiveUnavailableError(`blob get ${key} body 失败`, { cause: e });
        }
    }

    async head(key: string): Promise<{ size: number; etag?: string }> {
        try {
            const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
            return {
                size: res.ContentLength ?? 0,
                // S3 ETag 带引号（"abc..."），confirm 比对前须 strip——在此归一化
                etag: res.ETag ? res.ETag.replace(/^"|"$/g, '') : undefined
            };
        } catch (e) {
            throw mapGetError(key, e);
        }
    }

    async getRange(key: string, start: number, end: number): Promise<Buffer> {
        // Range 实现：走 GetObjectCommand + Range 头（S3 兼容网关普遍支持；七牛 OK）
        let body: { transformToByteArray(): Promise<Uint8Array> } | undefined;
        try {
            const res = await this.client.send(new GetObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Range: `bytes=${start}-${end}`
            }));
            body = res.Body as { transformToByteArray(): Promise<Uint8Array> };
        } catch (e) {
            throw mapGetError(key, e);
        }
        if (!body) throw new ObjectNotFoundError(key);
        try {
            return Buffer.from(await body.transformToByteArray());
        } catch (e) {
            // 同 get() 先例：header 阶段之外的 body 流中断（慢网络/传输截断）归入 503 语义，不裸抛降级 500
            throw new ArchiveUnavailableError(`blob getRange ${key} body 失败`, { cause: e });
        }
    }

    async delete(key: string): Promise<void> {
        try {
            await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
        } catch (e) {
            throw new ArchiveUnavailableError(`blob delete ${key} 失败`, { cause: e });
        }
    }

    /** 纯本地 HMAC 计算（SigV4），无网络 IO——每次调用微秒级 */
    async presign(op: 'get' | 'put', key: string, ttlSeconds: number): Promise<string> {
        const cmd = op === 'get'
            ? new GetObjectCommand({ Bucket: this.bucket, Key: key })
            : new PutObjectCommand({ Bucket: this.bucket, Key: key });
        return getSignedUrl(this.client, cmd, { expiresIn: ttlSeconds });
    }
}
