import { test, expect, afterEach } from 'vitest';
import {
    parseObjectStoreEnv, objectKeyFor, MemoryObjectStore,
    ObjectNotFoundError, ArchiveUnavailableError, getObjectStore, __setObjectStoreForTest
} from '../src/lib/server/object-store';
import { S3ObjectStore, mapGetError } from '../src/lib/server/object-store-s3';

const ORIG: NodeJS.ProcessEnv = { ...process.env };
afterEach(() => {
    for (const k of Object.keys(process.env)) {
        if (!(k in ORIG)) delete process.env[k];
    }
    Object.assign(process.env, ORIG);
    __setObjectStoreForTest(undefined);
});

test('OBJECT_STORE_* 全空 → null（功能关闭）', () => {
    expect(parseObjectStoreEnv({} as NodeJS.ProcessEnv)).toBeNull();
});

test('部分配置 → 抛错并列出缺失变量名', () => {
    expect(() => parseObjectStoreEnv({ OBJECT_STORE_BUCKET: 'b' } as NodeJS.ProcessEnv))
        .toThrow(/OBJECT_STORE_ENDPOINT|不完整/);
});

test('完整配置 → 返回配置对象，forcePathStyle 默认 false / "true" 开启', () => {
    const full = {
        OBJECT_STORE_ENDPOINT: 'https://s3.cn-east-1.qiniucs.com',
        OBJECT_STORE_REGION: 'cn-east-1',
        OBJECT_STORE_BUCKET: 'b',
        OBJECT_STORE_ACCESS_KEY_ID: 'ak',
        OBJECT_STORE_SECRET_ACCESS_KEY: 'sk'
    } as NodeJS.ProcessEnv;
    const cfg = parseObjectStoreEnv(full);
    expect(cfg).toMatchObject({ bucket: 'b', region: 'cn-east-1', forcePathStyle: false });
    expect(parseObjectStoreEnv({ ...full, OBJECT_STORE_FORCE_PATH_STYLE: 'true' } as NodeJS.ProcessEnv)?.forcePathStyle).toBe(true);
});

test('objectKeyFor：archive/<ownerId>/<docId>-<hash>.md；null hash 有保底', () => {
    expect(objectKeyFor({ ownerId: 'o1', id: 'd1', contentHash: 'abc' })).toBe('archive/o1/d1-abc.md');
    expect(objectKeyFor({ ownerId: 'o1', id: 'd1', contentHash: null })).toBe('archive/o1/d1-nohash.md');
});

test('MemoryObjectStore：put/get/delete 往返；缺失 get → ObjectNotFoundError；失败注入 → ArchiveUnavailableError', async () => {
    const s = new MemoryObjectStore();
    await s.put('k', 'v');
    expect(await s.get('k')).toBe('v');
    await expect(s.get('nope')).rejects.toBeInstanceOf(ObjectNotFoundError);
    s.failPut = true;
    await expect(s.put('k2', 'v2')).rejects.toBeInstanceOf(ArchiveUnavailableError);
    s.failPut = false;
    await s.delete('k');
    await expect(s.get('k')).rejects.toBeInstanceOf(ObjectNotFoundError);
});

test('getObjectStore 未配置 → null 且可被测试覆写', () => {
    expect(getObjectStore()).toBeNull();
    const fake = new MemoryObjectStore();
    __setObjectStoreForTest(fake);
    expect(getObjectStore()).toBe(fake);
});

test('mapGetError：NoSuchKey → ObjectNotFoundError，其余 → ArchiveUnavailableError', () => {
    expect(mapGetError('k', { name: 'NoSuchKey' })).toBeInstanceOf(ObjectNotFoundError);
    expect(mapGetError('k', new Error('network'))).toBeInstanceOf(ArchiveUnavailableError);
    expect(mapGetError('k', {})).toBeInstanceOf(ArchiveUnavailableError);
});
