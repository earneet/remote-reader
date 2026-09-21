import { describe, it, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { db, schema, sqlite } from '$server/db';
import { resetDb } from './helpers';
import { initImage, relayImage, confirmImage, resolveImageByName, type InitImageResult } from '$server/images';
import { LocalBlobStore } from '$server/blobstore-local';
import { __setBlobStoresForTest, type BlobStore } from '$server/blobstore';
import { ObjectNotFoundError } from '$server/object-store';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-img2-'));
process.env.DATA_DIR = DIR;
afterAll(() => { delete process.env.DATA_DIR; fs.rmSync(DIR, { recursive: true, force: true }); });

beforeEach(() => resetDb());
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
const JPG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(50, 3)]);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex');
function mkUser(id: string): void { sqlite.exec(`INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('${id}', '${id}@t.local', 'x', 'member', 0)`); }

// InitImageResult 联合中 exists 分支无 imageId——统一从这取（narrow 后类型安全）
function idOf(r: InitImageResult): string {
    if (r.status === 'exists') throw new Error(`期望 relay/direct，实际 exists（name=${r.name}）`);
    return r.imageId;
}

// fake s3（confirm 测试用）：内存 BlobStore，head 的 etag = 内容 md5（模拟 S3 单段 PUT ETag）
class FakeS3 implements BlobStore {
    readonly id = 's3';
    readonly uploadUrlTtlSeconds = 600;
    readonly deleted: string[] = [];
    private blobs = new Map<string, Buffer>();
    async put(key: string, data: Buffer): Promise<void> { this.blobs.set(key, data); }
    async get(key: string): Promise<Buffer> { const b = this.blobs.get(key); if (!b) throw new ObjectNotFoundError(key); return b; }
    async head(key: string): Promise<{ size: number; etag?: string }> { const b = this.blobs.get(key); if (!b) throw new ObjectNotFoundError(key); return { size: b.length, etag: md5(b) }; }
    async getRange(key: string, start: number, end: number): Promise<Buffer> { const b = this.blobs.get(key); if (!b) throw new ObjectNotFoundError(key); return b.subarray(start, end + 1); }
    async delete(key: string): Promise<void> { this.deleted.push(key); this.blobs.delete(key); }
    async presign(op: 'get' | 'put', key: string, ttl: number): Promise<string> { return `https://fake-s3/${op}/${key}?ttl=${ttl}`; }
}

describe('relayImage（spec §5.2）', () => {
    it('happy path：写盘 + ready + mime/size 实测回写 + sha256 字节绑定过', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1');
        const init = await initImage('u1', { name: 'a.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        const r = await relayImage('u1', idOf(init), PNG);
        expect(r.ok).toBe(true);
        const row = db.select().from(schema.images).where(eq(schema.images.id, idOf(init))).get()!;
        expect(row.status).toBe('ready');
        expect(row.mimeType).toBe('image/png');
        expect(row.sizeBytes).toBe(PNG.length);
    });
    it('P1-1 字节绑定：谎报 hash → invalid', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1');
        const init = await initImage('u1', { name: 'a.png', contentHash: 'a'.repeat(64), contentMd5: md5(PNG), sizeBytes: PNG.length });
        const r = await relayImage('u1', idOf(init), PNG);
        expect(r).toEqual({ ok: false, reason: 'invalid', message: expect.stringContaining('hash') });
    });
    it('P1-1 实测大小：init 谎报小 size + 实际超大字节（hash 真实）→ invalid 超上限', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1');
        const big = Buffer.concat([PNG, Buffer.alloc(11 * 1024 * 1024, 1)]); // > 10MB 默认上限，hash 真实
        const init = await initImage('u1', { name: 'a.png', contentHash: sha256(big), contentMd5: md5(big), sizeBytes: 1 });
        const r = await relayImage('u1', idOf(init), big);
        expect(r).toEqual({ ok: false, reason: 'invalid', message: expect.stringContaining('上限') });
    });
    it('魔数不符 → invalid 带文案（SVG 拒绝说明）', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1');
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        const init = await initImage('u1', { name: 'evil.svg.png', contentHash: sha256(svg), contentMd5: md5(svg), sizeBytes: svg.length });
        const r = await relayImage('u1', idOf(init), svg);
        expect(r.ok).toBe(false);
        if (!r.ok && r.reason === 'invalid') expect(r.message).toContain('SVG');
    });
    it('扩展名不一致：.jpg 名 + PNG 字节 → invalid', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1');
        const init = await initImage('u1', { name: 'misnamed.jpg', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        const r = await relayImage('u1', idOf(init), PNG);
        expect(r.ok).toBe(false);
        if (!r.ok && r.reason === 'invalid') expect(r.message).toContain('不一致');
    });
    it('扩展名双写法：jpeg mime 接受 .jpg 与 .jpeg', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1');
        const init = await initImage('u1', { name: 'photo.jpeg', contentHash: sha256(JPG), contentMd5: md5(JPG), sizeBytes: JPG.length });
        const r = await relayImage('u1', idOf(init), JPG);
        expect(r.ok).toBe(true);
    });
    it('P2-1 owner 作用域：非 owner 的 imageId → missing', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1'); mkUser('u2');
        const init = await initImage('u1', { name: 'a.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        const r = await relayImage('u2', idOf(init), PNG);
        expect(r).toEqual({ ok: false, reason: 'missing' });
    });
    it('条件式 UPDATE + 0 行回查：行已删 → missing；已 ready → 幂等 ok', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1');
        const init = await initImage('u1', { name: 'a.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        sqlite.exec(`DELETE FROM images WHERE id='${idOf(init)}'`);
        expect(await relayImage('u1', idOf(init), PNG)).toEqual({ ok: false, reason: 'missing' });
        const init2 = await initImage('u1', { name: 'b.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        await relayImage('u1', idOf(init2), PNG); // 第一次 ready
        expect((await relayImage('u1', idOf(init2), PNG)).ok).toBe(true); // 二次幂等
    });
});

describe('confirmImage（spec §5.3）', () => {
    beforeEach(() => { process.env.IMAGE_STORE_BACKEND = 's3'; }); // active 后端切 s3 → init 走 direct 分支
    afterEach(() => { delete process.env.IMAGE_STORE_BACKEND; }); // vitest 单 worker 共享 process.env，恢复防泄漏

    it('三重验证过 → ready（etag==md5）', async () => {
        const fake = new FakeS3();
        __setBlobStoresForTest({ local: new LocalBlobStore(), s3: fake });
        mkUser('u1');
        const init = await initImage('u1', { name: 'a.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        expect(init.status).toBe('direct'); // s3 注册 → direct 分支
        if (init.status !== 'direct') throw new Error('unreachable');
        await fake.put(init.uploadUrl.split('/put/')[1]!.split('?')[0], PNG); // 桥直传模拟
        const r = await confirmImage('u1', init.imageId);
        expect(r.ok).toBe(true);
        const row = db.select().from(schema.images).where(eq(schema.images.id, init.imageId)).get()!;
        expect(row.status).toBe('ready');
        expect(row.mimeType).toBe('image/png');
    });
    it('对象缺失 → missing', async () => {
        const fake = new FakeS3();
        __setBlobStoresForTest({ local: new LocalBlobStore(), s3: fake });
        mkUser('u1');
        const init = await initImage('u1', { name: 'a.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        const r = await confirmImage('u1', idOf(init));
        expect(r).toEqual({ ok: false, reason: 'missing' });
    });
    it('etag 不符 → invalid + 删云对象', async () => {
        const fake = new FakeS3();
        __setBlobStoresForTest({ local: new LocalBlobStore(), s3: fake });
        mkUser('u1');
        const init = await initImage('u1', { name: 'a.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        if (init.status !== 'direct') throw new Error('unreachable');
        const key = init.uploadUrl.split('/put/')[1]!.split('?')[0];
        // 篡改字节：合法 PNG 魔数 + 不同内容——魔数检查过、ETag(mdx) != 行内 md5 → 命中 etag 分支（顺序 size→magic→etag，spec §5.3）
        await fake.put(key, Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(120, 9)]));
        const r = await confirmImage('u1', init.imageId);
        expect(r.ok).toBe(false);
        expect(fake.deleted).toContain(key); // invalid 时删云对象
    });
});

describe('resolveImageByName', () => {
    it('只认 ready（pending/deleted/无行 → null）', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1');
        expect(resolveImageByName('u1', 'nope.png')).toBeNull();
        const init = await initImage('u1', { name: 'a.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        expect(resolveImageByName('u1', 'a.png')).toBeNull(); // pending
        await relayImage('u1', idOf(init), PNG);
        expect(resolveImageByName('u1', 'a.png')?.id).toBe(idOf(init));
    });
});
