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
    it('扩展名不一致（与 relay 校验对齐，spec §5.3/§11 双重承诺）：init 名 x.png + PUT jpeg 字节 → invalid', async () => {
        const fake = new FakeS3();
        __setBlobStoresForTest({ local: new LocalBlobStore(), s3: fake });
        mkUser('u1');
        const init = await initImage('u1', { name: 'x.png', contentHash: sha256(JPG), contentMd5: md5(JPG), sizeBytes: JPG.length });
        if (init.status !== 'direct') throw new Error('unreachable');
        await fake.put(init.uploadUrl.split('/put/')[1]!.split('?')[0], JPG); // 桥直传 jpeg 字节
        const r = await confirmImage('u1', init.imageId);
        expect(r.ok).toBe(false);
        if (!r.ok && r.reason === 'invalid') expect(r.message).toContain('不一致');
        // ETag==md5（FakeS3 head 即内容 md5）已证字节诚实 → (name,content) 错配永久 → 行删防死锁
        expect(db.select().from(schema.images).where(eq(schema.images.id, init.imageId)).get()).toBeUndefined();
    });
});

describe('initImage exists 分支 head 自愈（交叉审查 P1：blob 丢失 → exists 永续 → 裂图永续）', () => {
    const blobPathOf = (imageId: string): string => {
        const row = db.select({ storageKey: schema.images.storageKey }).from(schema.images).where(eq(schema.images.id, imageId)).get()!;
        return path.join(DIR, ...row.storageKey.split('/'));
    };

    it('ready 行 blob 丢失 → 不再 exists：降级墓碑复活重传，relay 后 ready 且 blob 恢复', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1');
        const first = await initImage('u1', { name: 'a.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        await relayImage('u1', idOf(first), PNG);
        expect(fs.existsSync(blobPathOf(idOf(first)))).toBe(true);
        fs.rmSync(blobPathOf(idOf(first))); // 模拟磁盘损坏/误删
        const again = await initImage('u1', { name: 'a.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        expect(again.status).toBe('relay'); // 不再 exists
        const r = await relayImage('u1', (again as { imageId: string }).imageId, PNG);
        expect(r.ok).toBe(true);
        expect(fs.existsSync(blobPathOf((again as { imageId: string }).imageId))).toBe(true); // blob 已恢复
        const row = db.select().from(schema.images).where(eq(schema.images.id, (again as { imageId: string }).imageId)).get()!;
        expect(row.status).toBe('ready');
        expect(row.name).toBe('a.png'); // 同名复活，裸名引用不断裂
    });

    it('blob 在 → 照旧 exists（幂等快路径不回退）', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1');
        await relayImage('u1', idOf(await initImage('u1', { name: 'a.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length })), PNG);
        const again = await initImage('u1', { name: 'other.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        expect(again.status).toBe('exists');
        expect(again.name).toBe('a.png');
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

describe('改名重传死锁修复（QA 实测：sha256 绑定后的 magic/ext 永久性失败 → 条件式删 pending 行）', () => {
    it('relay 主用例：.jpg 名 + PNG 字节 invalid → 同 hash 改名 .png 重传 → 新名生效 → ready', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1');
        const init1 = await initImage('u1', { name: 'photo.jpg', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        expect((await relayImage('u1', idOf(init1), PNG)).ok).toBe(false); // ext-mismatch invalid
        // 死锁核心：旧实现 pending 复用返回行内旧注册名 photo.jpg，用户按错误指引改名永远无效
        const init2 = await initImage('u1', { name: 'photo.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        expect(init2.status).toBe('relay');
        expect(init2.name).toBe('photo.png');
        const r2 = await relayImage('u1', idOf(init2), PNG);
        expect(r2.ok).toBe(true);
        if (r2.ok) expect(r2.name).toBe('photo.png');
        expect(resolveImageByName('u1', 'photo.png')?.id).toBe(idOf(init2));
    });

    it('relay magic-null（文本字节）invalid → 行删，同 hash 新名 init 得新行新名', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1');
        const txt = Buffer.from('plain text, not an image');
        const init1 = await initImage('u1', { name: 'note.png', contentHash: sha256(txt), contentMd5: md5(txt), sizeBytes: txt.length });
        expect((await relayImage('u1', idOf(init1), txt)).ok).toBe(false); // magic-null invalid
        expect(db.select().from(schema.images).where(eq(schema.images.id, idOf(init1))).get()).toBeUndefined(); // 行已删
        const init2 = await initImage('u1', { name: 'renamed.png', contentHash: sha256(txt), contentMd5: md5(txt), sizeBytes: txt.length });
        expect(init2.status).toBe('relay');
        expect(init2.name).toBe('renamed.png'); // 不再复用旧名
        expect(idOf(init2)).not.toBe(idOf(init1)); // 新建分支，非旧行复活
    });

    it('负面对照：sha256 谎报 invalid 不删行（字节可能非真值内容，行可能是无辜的）→ 再 init 同 hash 复用同一 pending 行', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1');
        const init1 = await initImage('u1', { name: 'a.png', contentHash: 'a'.repeat(64), contentMd5: md5(PNG), sizeBytes: PNG.length });
        expect((await relayImage('u1', idOf(init1), PNG)).ok).toBe(false); // hash 不符 invalid
        const init2 = await initImage('u1', { name: 'a.png', contentHash: 'a'.repeat(64), contentMd5: md5(PNG), sizeBytes: PNG.length });
        expect(idOf(init2)).toBe(idOf(init1)); // 同一 pending 行，imageId 不变
        expect(db.select().from(schema.images).where(eq(schema.images.id, idOf(init1))).get()!.status).toBe('pending');
    });

    it('relay invalid 删行后：再次 relay 同 imageId → missing（行已删）', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        mkUser('u1');
        const init = await initImage('u1', { name: 'y.jpg', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        expect((await relayImage('u1', idOf(init), PNG)).ok).toBe(false);
        expect(await relayImage('u1', idOf(init), PNG)).toEqual({ ok: false, reason: 'missing' });
    });
});

describe('confirm 改名重传死锁修复（s3 直传侧：ETag==md5 证诚实才删）', () => {
    beforeEach(() => { process.env.IMAGE_STORE_BACKEND = 's3'; }); // active 后端切 s3 → init 走 direct 分支
    afterEach(() => { delete process.env.IMAGE_STORE_BACKEND; });

    it('ext-mismatch 且 ETag==md5（内容诚实=永久错配）→ 行删，再 init 同 hash 得新名', async () => {
        const fake = new FakeS3();
        __setBlobStoresForTest({ local: new LocalBlobStore(), s3: fake });
        mkUser('u1');
        const init1 = await initImage('u1', { name: 'photo.jpg', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        if (init1.status !== 'direct') throw new Error('unreachable');
        await fake.put(init1.uploadUrl.split('/put/')[1]!.split('?')[0], PNG); // 直传 PNG 字节到 .jpg 名
        const r = await confirmImage('u1', init1.imageId);
        expect(r.ok).toBe(false); // ext-mismatch invalid
        expect(db.select().from(schema.images).where(eq(schema.images.id, init1.imageId)).get()).toBeUndefined(); // 行已删
        const init2 = await initImage('u1', { name: 'photo.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        expect(init2.status).toBe('direct');
        expect(init2.name).toBe('photo.png'); // 新名生效
    });

    it('magic-null 且 ETag==md5（内容诚实）→ 行删（文本对象非支持格式，永久性）', async () => {
        const fake = new FakeS3();
        __setBlobStoresForTest({ local: new LocalBlobStore(), s3: fake });
        mkUser('u1');
        const txt = Buffer.from('plain text, not an image');
        const init1 = await initImage('u1', { name: 'note.png', contentHash: sha256(txt), contentMd5: md5(txt), sizeBytes: txt.length });
        if (init1.status !== 'direct') throw new Error('unreachable');
        await fake.put(init1.uploadUrl.split('/put/')[1]!.split('?')[0], txt);
        const r = await confirmImage('u1', init1.imageId);
        expect(r.ok).toBe(false); // magic-null invalid
        expect(db.select().from(schema.images).where(eq(schema.images.id, init1.imageId)).get()).toBeUndefined(); // 行已删
    });

    it('ext-mismatch 但 ETag!=md5（内容未证诚实，行可能是无辜的）→ 行保留 pending', async () => {
        const fake = new FakeS3();
        __setBlobStoresForTest({ local: new LocalBlobStore(), s3: fake });
        mkUser('u1');
        const tampered = Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(120, 9)]); // PNG 魔数 + 篡改体 → head.etag != 行内 md5
        const init1 = await initImage('u1', { name: 'photo.jpg', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        if (init1.status !== 'direct') throw new Error('unreachable');
        await fake.put(init1.uploadUrl.split('/put/')[1]!.split('?')[0], tampered);
        const r = await confirmImage('u1', init1.imageId);
        expect(r.ok).toBe(false); // ext-mismatch（校验链先于 ETag 判定命中）
        const row = db.select().from(schema.images).where(eq(schema.images.id, init1.imageId)).get()!;
        expect(row.status).toBe('pending'); // 行保留
    });
});
