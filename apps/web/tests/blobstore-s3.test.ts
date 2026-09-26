import { describe, it, expect, vi, type Mock } from 'vitest';
import type { S3Client } from '@aws-sdk/client-s3';
import { S3BlobStore } from '$server/blobstore-s3';
import { ObjectNotFoundError, ArchiveUnavailableError } from '$server/object-store-errors';

const CFG = {
    endpoint: 'https://s3.cn-north-1.qiniucs.com',
    region: 'cn-north-1',
    bucket: 'test-bucket',
    accessKeyId: 'AKtest',
    secretAccessKey: 'SKtest',
    forcePathStyle: true
};

describe('S3BlobStore presign（本地计算，无网络 IO）', () => {
    it('presign get 输出 SigV4 query 签名形状', async () => {
        const store = new S3BlobStore(CFG);
        const url = await store.presign!('get', 'images/u-1/abcd', 3600);
        expect(url).toContain('https://s3.cn-north-1.qiniucs.com/test-bucket/images/u-1/abcd?');
        expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
        expect(url).toContain('X-Amz-SignedHeaders=host');
        expect(url).toMatch(/X-Amz-Expires=3600/);
        expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}/);
    });

    it('presign put 同形状；锁时间后同参数产出逐字节相同 URL（桶对齐的前提）', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
        try {
            const store = new S3BlobStore(CFG);
            const a = await store.presign!('put', 'k', 600);
            const b = await store.presign!('put', 'k', 600);
            expect(a).toBe(b); // X-Amz-Date 锁定后签名确定性（不锁会跨秒 flaky）
        } finally {
            vi.useRealTimers();
        }
    });

    it('uploadUrlTtlSeconds 默认 600', () => {
        expect(new S3BlobStore(CFG).uploadUrlTtlSeconds).toBe(600);
    });
});

describe('S3Client 兼容性配置', () => {
    // 2026-09-22 生产实证：七牛 Range GET 响应自相矛盾——Content-Range 声明分片、
    // content-md5 是分片 MD5、实际却流回全量 body；SDK ≥3.729 默认 WHEN_SUPPORTED
    // 会在消费 body 时抛 ChecksumMismatch → confirm 恒 503。WHEN_REQUIRED 是官方
    // 为这类 S3 兼容网关准备的开关（我们从不主动要求校验和，等效关闭校验）。
    it('responseChecksumValidation 必须 WHEN_REQUIRED（删掉它七牛 confirm 即 503）', async () => {
        const store = new S3BlobStore(CFG);
        const client = (store as unknown as { client: S3Client }).client;
        const v = client.config.responseChecksumValidation;
        const resolved = typeof v === 'function' ? await v() : v;
        expect(resolved).toBe('WHEN_REQUIRED');
    });

    // 审查跟进（2026-09-23）：SDK ≥3.729 默认 requestChecksumCalculation WHEN_SUPPORTED
    // 会把空载荷 CRC32（x-amz-checksum-crc32=AAAAAA==）与 x-amz-sdk-checksum-algorithm
    // 签进 presigned URL——七牛容忍，但严格 S3 兼容网关（R2/OSS/MinIO/真 AWS）会按
    // 该参数校验真实载荷 → direct PUT 被拒。与响应侧 WHEN_REQUIRED 成对，官方推荐位。
    it('requestChecksumCalculation 必须 WHEN_REQUIRED（presign URL 不得签入校验和参数）', async () => {
        const store = new S3BlobStore(CFG);
        const client = (store as unknown as { client: S3Client }).client;
        const v = client.config.requestChecksumCalculation;
        const resolved = typeof v === 'function' ? await v() : v;
        expect(resolved).toBe('WHEN_REQUIRED');
    });

    it('presign get/put URL 不含 x-amz-checksum* / x-amz-sdk-checksum-algorithm（跨网关 direct PUT 兼容性）', async () => {
        const store = new S3BlobStore(CFG);
        const get = await store.presign!('get', 'images/u-1/abcd', 600);
        const put = await store.presign!('put', 'images/u-1/abcd', 600);
        for (const url of [get, put]) {
            expect(url).not.toContain('x-amz-checksum');
            expect(url).not.toContain('X-Amz-Checksum');
            expect(url).not.toContain('checksum-algorithm');
        }
    });
});

describe('S3BlobStore 数据面（client.send 注入 SDK v3 响应形状，无网络 IO）', () => {
    type SendOut = Awaited<ReturnType<S3Client['send']>>;
    // SDK v3 的 Body 消费面是流式对象的 transformToByteArray——mock 只提供该形状（形状保真）
    const mkBody = (bytes: Uint8Array): { transformToByteArray(): Promise<Uint8Array> } => ({
        transformToByteArray: async () => bytes
    });
    function mkStore(): { store: S3BlobStore; send: Mock } {
        const store = new S3BlobStore(CFG);
        const client = (store as unknown as { client: S3Client }).client;
        return { store, send: vi.spyOn(client, 'send') };
    }

    it('getRange 封口契约（七牛怪癖）：Range GET 流回长于请求区间的全量 body → 返回恰好 [start,end] 闭区间字节', async () => {
        const { store, send } = mkStore();
        const full = Buffer.alloc(100, 7); // 网关无视 Range 流回 100B（七牛实证形态）
        send.mockResolvedValueOnce({ Body: mkBody(full) } as unknown as SendOut);
        const out = await store.getRange('k', 0, 31);
        expect(out.length).toBe(32);
        expect(out).toEqual(full.subarray(0, 32));
        send.mockRestore();
    });

    it('getRange 透传 Range 头 bytes=start-end', async () => {
        const { store, send } = mkStore();
        send.mockResolvedValueOnce({ Body: mkBody(new Uint8Array(32)) } as unknown as SendOut);
        await store.getRange('k', 5, 36);
        expect(send.mock.calls[0]?.[0]).toMatchObject({ input: { Range: 'bytes=5-36' } });
        send.mockRestore();
    });

    it('head：ETag 去引号归一化（confirm 比对 md5 的前置条件）', async () => {
        const { store, send } = mkStore();
        send.mockResolvedValueOnce({ ContentLength: 10, ETag: '"abc123"' } as unknown as SendOut);
        expect(await store.head('k')).toEqual({ size: 10, etag: 'abc123' });
        send.mockRestore();
    });

    it('get：Body 缺失 → ObjectNotFoundError（非裸 500）', async () => {
        const { store, send } = mkStore();
        send.mockResolvedValueOnce({} as unknown as SendOut);
        await expect(store.get('k')).rejects.toBeInstanceOf(ObjectNotFoundError);
        send.mockRestore();
    });

    it('get/getRange：body 流消费中断 → ArchiveUnavailableError（503 语义，不降级裸 500）', async () => {
        const broken = (): { transformToByteArray(): Promise<Uint8Array> } => ({
            transformToByteArray: async () => { throw new Error('truncated'); }
        });
        const a = mkStore();
        a.send.mockResolvedValueOnce({ Body: broken() } as unknown as SendOut);
        await expect(a.store.get('k')).rejects.toBeInstanceOf(ArchiveUnavailableError);
        a.send.mockRestore();
        const b = mkStore();
        b.send.mockResolvedValueOnce({ Body: broken() } as unknown as SendOut);
        await expect(b.store.getRange('k', 0, 3)).rejects.toBeInstanceOf(ArchiveUnavailableError);
        b.send.mockRestore();
    });
});
