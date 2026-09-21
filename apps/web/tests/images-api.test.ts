import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db, schema } from '$server/db';
import { resetDb } from './helpers';
import { generateApiToken, generateId } from '$server/auth';
import { initImage, relayImage, type InitImageResult } from '$server/images';
import { LocalBlobStore } from '$server/blobstore-local';
import { __setBlobStoresForTest, type BlobStore } from '$server/blobstore';
import { ObjectNotFoundError } from '$server/object-store';
import { createShareLink } from '$server/shares';
import { eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 五个待实现路由（Task 8）：RED 阶段模块不存在 → 本文件加载失败即预期红
const { POST: initPost } = await import('../src/routes/api/v1/images/init/+server');
const { POST: relayPost } = await import('../src/routes/api/v1/images/+server');
const { POST: confirmPost } = await import('../src/routes/api/v1/images/confirm/+server');
const { GET: shareImgGet } = await import('../src/routes/s/[token]/i/[name]/+server');
const { GET: ownerImgGet } = await import('../src/routes/d/[id]/i/[name]/+server');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-imgapi-'));
process.env.DATA_DIR = DIR;
afterAll(() => {
    delete process.env.DATA_DIR;
    __setBlobStoresForTest(undefined);
    fs.rmSync(DIR, { recursive: true, force: true });
});

const INIT_URL = 'http://localhost/api/v1/images/init';
const RELAY_URL = 'http://localhost/api/v1/images';
const CONFIRM_URL = 'http://localhost/api/v1/images/confirm';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
const PNG2 = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100, 9)]);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex');

// fake s3（confirm/direct 用）：同 images-relay-confirm.test.ts，head 的 etag = 内容 md5
class FakeS3 implements BlobStore {
    readonly id = 's3';
    readonly uploadUrlTtlSeconds = 600;
    private blobs = new Map<string, Buffer>();
    async put(key: string, data: Buffer): Promise<void> { this.blobs.set(key, data); }
    async get(key: string): Promise<Buffer> { const b = this.blobs.get(key); if (!b) throw new ObjectNotFoundError(key); return b; }
    async head(key: string): Promise<{ size: number; etag?: string }> { const b = this.blobs.get(key); if (!b) throw new ObjectNotFoundError(key); return { size: b.length, etag: md5(b) }; }
    async getRange(key: string, start: number, end: number): Promise<Buffer> { const b = this.blobs.get(key); if (!b) throw new ObjectNotFoundError(key); return b.subarray(start, end + 1); }
    async delete(key: string): Promise<void> { this.blobs.delete(key); }
    async presign(op: 'get' | 'put', key: string, ttl: number): Promise<string> { return `https://fake-s3/${op}/${key}?ttl=${ttl}`; }
}

let ownerId: string;
let validAuth: string;

async function mkUserWithToken(id: string): Promise<string> {
    db.insert(schema.users).values({
        id, email: `${id}@t.local`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    const t = await generateApiToken();
    db.insert(schema.apiTokens).values({
        id: generateId(), userId: id, name: `tok-${id}`, tokenHash: t.hash, createdAt: Date.now()
    }).run();
    return `Bearer ${t.plaintext}`;
}

beforeEach(async () => {
    resetDb();
    __setBlobStoresForTest({ local: new LocalBlobStore() });
    ownerId = generateId();
    validAuth = await mkUserWithToken(ownerId);
});

function idOf(r: InitImageResult): string {
    if (r.status === 'exists') throw new Error(`期望 relay/direct，实际 exists（name=${r.name}）`);
    return r.imageId;
}

// —— POST 路由调用（upload-api.test.ts 同款：new Request 直调 handler + HttpError catch） ——
// handler 形参用 never（bottom 类型，双向兼容各路由 RequestHandler 的 RouteId 泛型），调用点零转换
async function callPost<H extends (event: never) => Response | Promise<Response>>(
    handler: H, url: string, headers: Record<string, string>, body: unknown, address = '127.0.0.1'
) {
    const request = new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });
    const event = { request, getClientAddress: () => address };
    try {
        const r = await handler(event as never);
        return { status: r.status, body: await r.json().catch(() => null) };
    } catch (e) {
        return { status: (e as { status?: number })?.status ?? 500, body: (e as { body?: unknown })?.body ?? null };
    }
}

// —— 代理 GET 路由调用：setHeaders stub 收集后断言 ——
async function callShareGet(params: { token: string; name: string }, headers: Record<string, string> = {}) {
    const collected: Record<string, string> = {};
    const request = new Request(`http://localhost/s/${params.token}/i/${encodeURIComponent(params.name)}`, { method: 'GET', headers });
    const event = { request, params, setHeaders: (h: Record<string, string>) => { Object.assign(collected, h); } };
    try {
        const res = await shareImgGet(event as unknown as Parameters<typeof shareImgGet>[0]);
        const bytes = Buffer.from(await res.arrayBuffer());
        return { status: res.status, headers: collected, res, bytes };
    } catch (e) {
        return { status: (e as { status?: number })?.status ?? 500, headers: collected, res: null, bytes: null };
    }
}

async function callOwnerGet(params: { id: string; name: string }, user: { id: string } | null, headers: Record<string, string> = {}) {
    const collected: Record<string, string> = {};
    const request = new Request(`http://localhost/d/${params.id}/i/${encodeURIComponent(params.name)}`, { method: 'GET', headers });
    const event = { request, params, locals: { user }, setHeaders: (h: Record<string, string>) => { Object.assign(collected, h); } };
    try {
        const res = await ownerImgGet(event as unknown as Parameters<typeof ownerImgGet>[0]);
        const bytes = Buffer.from(await res.arrayBuffer());
        return { status: res.status, headers: collected, res, bytes };
    } catch (e) {
        return { status: (e as { status?: number })?.status ?? 500, headers: collected, res: null, bytes: null };
    }
}

// —— 种子辅助 ——
function insertDoc(id: string, owner: string): string {
    db.insert(schema.documents).values({
        id, ownerId: owner, parentId: null, name: `${id}.md`, type: 'file',
        storagePath: null, contentHash: null, sizeBytes: null,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    return id;
}

async function mkReadyImage(owner: string, name: string, bytes: Buffer): Promise<string> {
    const init = await initImage(owner, { name, contentHash: sha256(bytes), contentMd5: md5(bytes), sizeBytes: bytes.length });
    const imageId = idOf(init);
    const r = await relayImage(owner, imageId, bytes);
    if (!r.ok) throw new Error('seed relay 失败');
    return imageId;
}

describe('POST /api/v1/images/init', () => {
    it('无 token → 401', async () => {
        expect((await callPost(initPost, INIT_URL, {}, { name: 'a.png', content_hash: sha256(PNG), content_md5: md5(PNG), size_bytes: 1 })).status).toBe(401);
    });
    it('错 token → 401', async () => {
        expect((await callPost(initPost, INIT_URL, { authorization: 'Bearer rr_wrong' }, { name: 'a.png', content_hash: sha256(PNG), content_md5: md5(PNG), size_bytes: 1 })).status).toBe(401);
    });
    it('缺字段 → 400', async () => {
        expect((await callPost(initPost, INIT_URL, { authorization: validAuth }, { name: 'a.png' })).status).toBe(400);
    });
    it('hash 格式非法 → 400 且透传服务层文案（P0-1 防路径穿越）', async () => {
        const r = await callPost(initPost, INIT_URL, { authorization: validAuth }, { name: 'a.png', content_hash: '../../evil', content_md5: md5(PNG), size_bytes: 1 });
        expect(r.status).toBe(400);
        expect((r.body as { message?: string }).message).toContain('content_hash');
    });
    it('size_bytes 超限 → 413', async () => {
        const r = await callPost(initPost, INIT_URL, { authorization: validAuth }, { name: 'a.png', content_hash: sha256(PNG), content_md5: md5(PNG), size_bytes: 11 * 1024 * 1024 });
        expect(r.status).toBe(413);
    });
    it('新图 → relay 三态形状（精确字段集）', async () => {
        const r = await callPost(initPost, INIT_URL, { authorization: validAuth }, { name: 'a.png', content_hash: sha256(PNG), content_md5: md5(PNG), size_bytes: PNG.length });
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ status: 'relay', name: 'a.png', imageId: expect.any(String) });
    });
    it('同 hash ready 再 init → exists 形状（仅 status/name）', async () => {
        await mkReadyImage(ownerId, 'a.png', PNG);
        const r = await callPost(initPost, INIT_URL, { authorization: validAuth }, { name: 'new-name.png', content_hash: sha256(PNG), content_md5: md5(PNG), size_bytes: PNG.length });
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ status: 'exists', name: 'a.png' });
    });
    it('s3 注册时 → direct 形状（含 uploadUrl）', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore(), s3: new FakeS3() });
        process.env.IMAGE_STORE_BACKEND = 's3';
        try {
            const r = await callPost(initPost, INIT_URL, { authorization: validAuth }, { name: 'd.png', content_hash: sha256(PNG2), content_md5: md5(PNG2), size_bytes: PNG2.length });
            expect(r.status).toBe(200);
            expect(r.body).toEqual({ status: 'direct', name: 'd.png', imageId: expect.any(String), uploadUrl: expect.any(String) });
        } finally {
            delete process.env.IMAGE_STORE_BACKEND;
        }
    });
    it('连续 121 次 → 第 121 次 429（images-meta 轻桶默认 120）', async () => {
        const body = { name: 'spam.png', content_hash: sha256(PNG), content_md5: md5(PNG), size_bytes: PNG.length };
        for (let i = 0; i < 120; i++) {
            const r = await callPost(initPost, INIT_URL, { authorization: validAuth }, body);
            if (r.status !== 200) throw new Error(`第 ${i + 1} 次意外 ${r.status}`);
        }
        expect((await callPost(initPost, INIT_URL, { authorization: validAuth }, body)).status).toBe(429);
    });
});

describe('POST /api/v1/images（relay）', () => {
    it('无 token → 401', async () => {
        expect((await callPost(relayPost, RELAY_URL, {}, { image_id: 'x', content_base64: 'eA==' })).status).toBe(401);
    });
    it('缺字段 → 400', async () => {
        expect((await callPost(relayPost, RELAY_URL, { authorization: validAuth }, { image_id: 'x' })).status).toBe(400);
    });
    it('ok：init 后中转 PNG → 200 {name} + 行 ready', async () => {
        const init = await callPost(initPost, INIT_URL, { authorization: validAuth }, { name: 'a.png', content_hash: sha256(PNG), content_md5: md5(PNG), size_bytes: PNG.length });
        const imageId = (init.body as { imageId: string }).imageId;
        const r = await callPost(relayPost, RELAY_URL, { authorization: validAuth }, { image_id: imageId, content_base64: PNG.toString('base64') });
        expect(r.status).toBe(200);
        expect(r.body).toEqual({ name: 'a.png' });
        const row = db.select().from(schema.images).where(eq(schema.images.id, imageId)).get();
        expect(row?.status).toBe('ready');
    });
    it('missing：不存在的 image_id → 404 且错误形状 {message}', async () => {
        const r = await callPost(relayPost, RELAY_URL, { authorization: validAuth }, { image_id: 'nope', content_base64: PNG.toString('base64') });
        expect(r.status).toBe(404);
        expect(typeof (r.body as { message?: string }).message).toBe('string');
    });
    it('invalid：SVG 字节 → 400 json 形状 {status:"invalid",reason 含 SVG}', async () => {
        const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
        const init = await callPost(initPost, INIT_URL, { authorization: validAuth }, { name: 'evil.png', content_hash: sha256(svg), content_md5: md5(svg), size_bytes: svg.length });
        const imageId = (init.body as { imageId: string }).imageId;
        const r = await callPost(relayPost, RELAY_URL, { authorization: validAuth }, { image_id: imageId, content_base64: svg.toString('base64') });
        expect(r.status).toBe(400);
        expect(r.body).toMatchObject({ status: 'invalid' });
        expect((r.body as { reason?: string }).reason).toContain('SVG');
    });
    it('owner 作用域：u2 token 中转 u1 的图 → 404', async () => {
        const init = await callPost(initPost, INIT_URL, { authorization: validAuth }, { name: 'a.png', content_hash: sha256(PNG), content_md5: md5(PNG), size_bytes: PNG.length });
        const imageId = (init.body as { imageId: string }).imageId;
        const u2Auth = await mkUserWithToken(generateId());
        const r = await callPost(relayPost, RELAY_URL, { authorization: u2Auth }, { image_id: imageId, content_base64: PNG.toString('base64') });
        expect(r.status).toBe(404);
    });
});

describe('POST /api/v1/images/confirm', () => {
    it('无 token → 401', async () => {
        expect((await callPost(confirmPost, CONFIRM_URL, {}, { image_id: 'x' })).status).toBe(401);
    });
    it('缺字段 → 400', async () => {
        expect((await callPost(confirmPost, CONFIRM_URL, { authorization: validAuth }, {})).status).toBe(400);
    });
    it('ok：fake s3 直传后确认 → 200 {status:"ok",name}', async () => {
        const fake = new FakeS3();
        __setBlobStoresForTest({ local: new LocalBlobStore(), s3: fake });
        process.env.IMAGE_STORE_BACKEND = 's3';
        try {
            const init = await callPost(initPost, INIT_URL, { authorization: validAuth }, { name: 'a.png', content_hash: sha256(PNG), content_md5: md5(PNG), size_bytes: PNG.length });
            const { imageId, uploadUrl } = init.body as { imageId: string; uploadUrl: string };
            await fake.put(uploadUrl.split('/put/')[1]!.split('?')[0], PNG); // 桥直传模拟
            const r = await callPost(confirmPost, CONFIRM_URL, { authorization: validAuth }, { image_id: imageId });
            expect(r.status).toBe(200);
            expect(r.body).toEqual({ status: 'ok', name: 'a.png' });
        } finally {
            delete process.env.IMAGE_STORE_BACKEND;
        }
    });
    it('missing：不存在 → 404 json 形状 {status:"missing"}', async () => {
        const r = await callPost(confirmPost, CONFIRM_URL, { authorization: validAuth }, { image_id: 'nope' });
        expect(r.status).toBe(404);
        expect(r.body).toEqual({ status: 'missing' });
    });
    it('invalid：etag 不符 → 400 json 形状 {status:"invalid",reason}', async () => {
        const fake = new FakeS3();
        __setBlobStoresForTest({ local: new LocalBlobStore(), s3: fake });
        process.env.IMAGE_STORE_BACKEND = 's3';
        try {
            const init = await callPost(initPost, INIT_URL, { authorization: validAuth }, { name: 'a.png', content_hash: sha256(PNG), content_md5: md5(PNG), size_bytes: PNG.length });
            const { imageId, uploadUrl } = init.body as { imageId: string; uploadUrl: string };
            const key = uploadUrl.split('/put/')[1]!.split('?')[0];
            await fake.put(key, Buffer.concat([PNG.subarray(0, 8), Buffer.alloc(120, 9)])); // 篡改字节
            const r = await callPost(confirmPost, CONFIRM_URL, { authorization: validAuth }, { image_id: imageId });
            expect(r.status).toBe(400);
            expect(r.body).toMatchObject({ status: 'invalid' });
            expect(typeof (r.body as { reason?: string }).reason).toBe('string');
        } finally {
            delete process.env.IMAGE_STORE_BACKEND;
        }
    });
});

describe('GET /s/[token]/i/[name]（share 代理）', () => {
    async function seed(): Promise<{ token: string; docId: string; imageId: string }> {
        const imageId = await mkReadyImage(ownerId, 'shot.png', PNG);
        const docId = insertDoc(generateId(), ownerId);
        db.insert(schema.imageRefs).values({ documentId: docId, imageId, createdAt: Date.now() }).run();
        const { token } = await createShareLink(docId);
        return { token, docId, imageId };
    }

    it('合法 token + refs 命中 → 200 + 全响应头 + 字节正确', async () => {
        const { token } = await seed();
        const r = await callShareGet({ token, name: 'shot.png' });
        expect(r.status).toBe(200);
        expect(r.headers['Content-Type']).toBe('image/png');
        expect(r.headers['X-Content-Type-Options']).toBe('nosniff');
        expect(r.headers['Cache-Control']).toBe('no-cache');
        expect(r.headers['ETag']).toBe(`"${sha256(PNG)}"`);
        expect(r.bytes?.equals(PNG)).toBe(true);
    });
    it('If-None-Match 命中 ETag → 304 无 body', async () => {
        const { token } = await seed();
        const r = await callShareGet({ token, name: 'shot.png' }, { 'if-none-match': `"${sha256(PNG)}"` });
        expect(r.status).toBe(304);
        expect(r.bytes?.length).toBe(0);
        expect(r.res?.headers.get('etag')).toBe(`"${sha256(PNG)}"`);
    });
    it('token 无效 → 404', async () => {
        await seed();
        const r = await callShareGet({ token: 'nope', name: 'shot.png' });
        expect(r.status).toBe(404);
    });
    it('refs 白名单：图 ready 但非该 md 引用（被别的 md 引用）→ 404（share token 不能枚举 owner 其他图）', async () => {
        const { token } = await seed();
        const otherId = await mkReadyImage(ownerId, 'other.png', PNG2);
        const doc2 = insertDoc(generateId(), ownerId);
        db.insert(schema.imageRefs).values({ documentId: doc2, imageId: otherId, createdAt: Date.now() }).run();
        const r = await callShareGet({ token, name: 'other.png' });
        expect(r.status).toBe(404);
    });
    it('pending 图（即使有 ref 行）→ 404（resolve 只认 ready）', async () => {
        const { token, docId } = await seed();
        const init = await initImage(ownerId, { name: 'pend.png', contentHash: sha256(PNG2), contentMd5: md5(PNG2), sizeBytes: PNG2.length });
        db.insert(schema.imageRefs).values({ documentId: docId, imageId: idOf(init), createdAt: Date.now() }).run();
        const r = await callShareGet({ token, name: 'pend.png' });
        expect(r.status).toBe(404);
    });
});

describe('GET /d/[id]/i/[name]（owner 代理）', () => {
    async function seed(): Promise<{ docId: string; imageId: string } > {
        const imageId = await mkReadyImage(ownerId, 'shot.png', PNG);
        const docId = insertDoc(generateId(), ownerId);
        db.insert(schema.imageRefs).values({ documentId: docId, imageId, createdAt: Date.now() }).run();
        return { docId, imageId };
    }

    it('无 session → 401', async () => {
        const { docId } = await seed();
        const r = await callOwnerGet({ id: docId, name: 'shot.png' }, null);
        expect(r.status).toBe(401);
    });
    it('owner session + refs 命中 → 200 + 头 + 字节', async () => {
        const { docId } = await seed();
        const r = await callOwnerGet({ id: docId, name: 'shot.png' }, { id: ownerId });
        expect(r.status).toBe(200);
        expect(r.headers['Content-Type']).toBe('image/png');
        expect(r.headers['ETag']).toBe(`"${sha256(PNG)}"`);
        expect(r.bytes?.equals(PNG)).toBe(true);
    });
    it('非 owner → 404', async () => {
        const { docId } = await seed();
        const r = await callOwnerGet({ id: docId, name: 'shot.png' }, { id: generateId() });
        expect(r.status).toBe(404);
    });
});
