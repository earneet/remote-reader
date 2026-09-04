import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { ObjectStore, ObjectStoreConfig } from './object-store';
import { ObjectNotFoundError, ArchiveUnavailableError } from './object-store';

// GET 错误映射：NoSuchKey → 对象缺失（404 语义）；其余 → 不可达（503 语义）
export function mapGetError(key: string, e: unknown): Error {
    if ((e as { name?: string }).name === 'NoSuchKey') return new ObjectNotFoundError(key);
    return new ArchiveUnavailableError(`get ${key} 失败`, { cause: e });
}

export class S3ObjectStore implements ObjectStore {
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
            // SDK 默认无请求超时：挂起端点会拖死冷读请求与文档锁，快速失败交给 503 语义（spec §5）
            requestHandler: new NodeHttpHandler({ requestTimeout: 5_000 }),
            maxAttempts: 2
        });
        this.bucket = config.bucket;
    }

    async put(key: string, content: string): Promise<void> {
        try {
            await this.client.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: content,
                ContentType: 'text/markdown; charset=utf-8'
            }));
        } catch (e) {
            throw new ArchiveUnavailableError(`put ${key} 失败`, { cause: e });
        }
    }

    async get(key: string): Promise<string> {
        let body: { transformToString(encoding: string): Promise<string> } | undefined;
        try {
            const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
            body = res.Body;
        } catch (e) {
            throw mapGetError(key, e);
        }
        if (!body) throw new ObjectNotFoundError(key);
        return body.transformToString('utf-8');
    }

    async delete(key: string): Promise<void> {
        try {
            await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
        } catch (e) {
            throw new ArchiveUnavailableError(`delete ${key} 失败`, { cause: e });
        }
    }
}
