import { describe, it, expect, vi } from 'vitest';
import { S3BlobStore } from '$server/blobstore-s3';

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
