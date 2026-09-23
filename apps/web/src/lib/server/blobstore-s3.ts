import {
    S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { ObjectStoreConfig } from './object-store';
import { ObjectNotFoundError, ArchiveUnavailableError, mapGetError } from './object-store-errors';
import type { BlobStore } from './blobstore';

// s3 插件（spec §8）：Buffer 语义 + head/getRange/presign。
// S3Client 构建/超时/重试配置的单源——S3ObjectStore（冷档 string 语义）以适配器转调本类（Phase 5 收敛）。
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
            // 挂起端点快速失败交给 503 语义（冷档与图片 blob 共用此单源配置）
            requestHandler: new NodeHttpHandler({ requestTimeout: 5_000 }),
            maxAttempts: 2,
            // 七牛实证（2026-09-22）：其 Range GET 响应自相矛盾——Content-Range 声明分片、
            // content-md5 给分片 MD5、实际流回全量 body；SDK ≥3.729 默认 WHEN_SUPPORTED
            // 消费 body 时校验不过抛 ChecksumMismatch → confirm 恒 503。
            // WHEN_REQUIRED = 仅请求方显式要求时才校验（我们从不要求），官方推荐的
            // S3 兼容网关兼容位。注意七牛仍会流回全量 body，getRange 内 subarray 封口长度契约。
            responseChecksumValidation: 'WHEN_REQUIRED',
            // 请求侧成对兼容位（审查跟进 2026-09-23）：默认 WHEN_SUPPORTED 会把空载荷 CRC32
            // （x-amz-checksum-crc32=AAAAAA==）签进 presigned URL——严格网关（R2/OSS/MinIO/真 AWS）
            // 按参数校验真实载荷会拒收 direct PUT。我们从不依赖请求校验和，关掉零损失。
            requestChecksumCalculation: 'WHEN_REQUIRED'
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
            const raw = Buffer.from(await body.transformToByteArray());
            // 接口契约封口：返回 [start, end] 闭区间字节。七牛无视 Range 流回全量 body，
            // subarray 零拷贝截到请求长度，调用方无需感知网关怪癖（短对象自然短于请求区间，subarray 安全）
            return raw.subarray(0, end - start + 1);
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
