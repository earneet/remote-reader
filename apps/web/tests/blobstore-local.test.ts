import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBlobStore } from '$server/blobstore-local';
import { ObjectNotFoundError } from '$server/object-store';

const DIR = mkdtempSync(join(tmpdir(), 'rr-blob-'));
// DATA_DIR 指向临时目录——必须在任何 store 调用前设置（LocalBlobStore 每次调用时读 getDataDir()）；
// afterAll 恢复：vitest 单 worker 共享 process.env，不恢复会泄漏到后续测试文件
process.env.DATA_DIR = DIR;
afterAll(() => {
    delete process.env.DATA_DIR;
    rmSync(DIR, { recursive: true, force: true });
});

describe('LocalBlobStore', () => {
    const store = new LocalBlobStore();
    // key = <ownerId>/blobs/<h2>/<hash>（per-owner 内容寻址，DATA_DIR 为根）
    const KEY = 'u-123/blobs/ab/abcdef0123';

    it('put→get 往返字节一致（Buffer）', async () => {
        const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        await store.put(KEY, data, 'image/png');
        expect(await store.get(KEY)).toEqual(data);
    });

    it('put 幂等覆盖（同 key 重写）', async () => {
        await store.put(KEY, Buffer.from([1, 2, 3]));
        await store.put(KEY, Buffer.from([4, 5]));
        expect((await store.get(KEY)).length).toBe(2);
    });

    it('head 返回 size', async () => {
        await store.put(KEY, Buffer.alloc(1234));
        const h = await store.head!(KEY);
        expect(h.size).toBe(1234);
        expect(h.etag).toBeUndefined(); // local 无 ETag（confirm 的 md5 校验仅 s3 路径）
    });

    it('getRange 读局部（confirm 魔数预判用）', async () => {
        const data = Buffer.alloc(100, 7);
        await store.put(KEY, data);
        const head = await store.getRange!(KEY, 0, 31);
        expect(head.length).toBe(32);
        expect(head[0]).toBe(7);
    });

    it('get 未命中 → ObjectNotFoundError（404 语义）', async () => {
        await expect(store.get('u-123/blobs/00/nonexistent')).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    it('delete 后 get 抛 NotFound；delete 幂等（ENOENT 视为成功）', async () => {
        await store.delete(KEY);
        await expect(store.get(KEY)).rejects.toBeInstanceOf(ObjectNotFoundError); // 用例名的前半断言
        await expect(store.delete(KEY)).resolves.toBeUndefined();
    });

    it('key 含路径穿越段 → 拒绝（纵深防御，key 本应恒为服务端生成）', async () => {
        await expect(store.get('../escape')).rejects.toThrow();
        await expect(store.put('a/../../escape', Buffer.from('x'))).rejects.toThrow();
    });
});
