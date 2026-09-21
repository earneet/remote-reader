import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getBlobStore, getActiveImageStore, __setBlobStoresForTest } from '$server/blobstore';
import { LocalBlobStore } from '$server/blobstore-local';

describe('blobstore 注册表', () => {
    beforeEach(() => __setBlobStoresForTest(undefined));
    afterEach(() => __setBlobStoresForTest(undefined));

    it('local 恒注册且为默认 active', () => {
        const s = getActiveImageStore();
        expect(s.id).toBe('local');
        expect(getBlobStore('local')).toBeInstanceOf(LocalBlobStore);
    });

    it('未配 OBJECT_STORE_* 时 s3 不注册，查询返回 null', () => {
        delete process.env.OBJECT_STORE_ENDPOINT;
        expect(getBlobStore('s3')).toBeNull();
    });

    it('IMAGE_STORE_BACKEND=s3 但 s3 未注册 → active 抛错（运行时防御，startup-check 先拦）', () => {
        process.env.IMAGE_STORE_BACKEND = 's3';
        delete process.env.OBJECT_STORE_ENDPOINT;
        __setBlobStoresForTest(undefined); // 清缓存重算
        expect(() => getActiveImageStore()).toThrow(/s3/);
        delete process.env.IMAGE_STORE_BACKEND;
    });

    it('测试钩子可注入 fake', () => {
        const fake = new LocalBlobStore();
        __setBlobStoresForTest({ local: fake });
        expect(getBlobStore('local')).toBe(fake);
    });
});
