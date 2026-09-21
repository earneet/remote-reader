import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest';
import { db, schema, sqlite } from '$server/db';
import { resetDb } from './helpers';
import { initImage, relayImage, confirmImage } from '$server/images';
import { renderMarkdown } from '$server/markdown';
import { resolveImages, __resetPresignCacheForTest, type ResolveCtx } from '$server/images-resolve';
import { LocalBlobStore } from '$server/blobstore-local';
import { __setBlobStoresForTest, type BlobStore } from '$server/blobstore';
import { ObjectNotFoundError } from '$server/object-store';
import { createHash } from 'node:crypto';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-imgres-'));
process.env.DATA_DIR = DIR;
afterAll(() => {
    delete process.env.DATA_DIR;
    __setBlobStoresForTest(undefined);
    fs.rmSync(DIR, { recursive: true, force: true });
});

beforeEach(() => {
    resetDb();
    __setBlobStoresForTest({ local: new LocalBlobStore() });
    __resetPresignCacheForTest(); // presignCache 模级——桶对齐/计数断言前置清空
});
afterEach(() => {
    delete process.env.IMAGE_STORE_BACKEND;
    delete process.env.IMAGE_PROXY_ALL;
});

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBytes = (seed: number): Buffer => Buffer.concat([PNG_MAGIC, Buffer.alloc(120, seed)]);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex');

function mkUser(id: string): void {
    sqlite.exec(`INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('${id}', '${id}@t.local', 'x', 'member', 0)`);
}
function mkDoc(id: string, ownerId: string, contentHash: string | null = null): void {
    sqlite.exec(`INSERT INTO documents (id, owner_id, name, type, content_hash, created_at, updated_at)
        VALUES ('${id}', '${ownerId}', '${id}.md', 'file', ${contentHash === null ? 'NULL' : `'${contentHash}'`}, 0, 0)`);
}

// 正路建 ready 图：initImage + relayImage 真实 PNG 字节（不同 seed = 不同 hash → 不撞去重池）
async function mkReadyImage(ownerId: string, name: string, data: Buffer): Promise<string> {
    const init = await initImage(ownerId, { name, contentHash: sha256(data), contentMd5: md5(data), sizeBytes: data.length });
    if (init.status === 'exists') throw new Error(`mkReadyImage 撞去重池（${name}）`);
    const r = await relayImage(ownerId, init.imageId, data);
    if (!r.ok) throw new Error(`mkReadyImage relay 失败: ${JSON.stringify(r)}`);
    return init.imageId;
}

// 正路建 s3 ready 图：active 切 s3 → init direct 分支 → 桥直传模拟 → confirm 三重验证
async function mkS3ReadyImage(fake: FakeS3, ownerId: string, name: string, data: Buffer): Promise<string> {
    process.env.IMAGE_STORE_BACKEND = 's3';
    try {
        const init = await initImage(ownerId, { name, contentHash: sha256(data), contentMd5: md5(data), sizeBytes: data.length });
        if (init.status !== 'direct') throw new Error(`mkS3ReadyImage 期望 direct，实际 ${init.status}`);
        const key = init.uploadUrl.split('/put/')[1]!.split('?')[0];
        await fake.put(key, data);
        const r = await confirmImage(ownerId, init.imageId);
        if (!r.ok) throw new Error(`mkS3ReadyImage confirm 失败: ${JSON.stringify(r)}`);
        return init.imageId;
    } finally {
        delete process.env.IMAGE_STORE_BACKEND;
    }
}

// fake s3：presign URL 带 Date.now()（桶对齐测试跨桶可观测差异）+ get-op 计数（IMAGE_PROXY_ALL 断言）
class FakeS3 implements BlobStore {
    readonly id = 's3';
    readonly uploadUrlTtlSeconds = 600;
    presignGetCalls = 0;
    private blobs = new Map<string, Buffer>();
    async put(key: string, data: Buffer): Promise<void> { this.blobs.set(key, data); }
    async get(key: string): Promise<Buffer> { const b = this.blobs.get(key); if (!b) throw new ObjectNotFoundError(key); return b; }
    async head(key: string): Promise<{ size: number; etag?: string }> { const b = this.blobs.get(key); if (!b) throw new ObjectNotFoundError(key); return { size: b.length, etag: md5(b) }; }
    async getRange(key: string, start: number, end: number): Promise<Buffer> { const b = this.blobs.get(key); if (!b) throw new ObjectNotFoundError(key); return b.subarray(start, end + 1); }
    async delete(key: string): Promise<void> { this.blobs.delete(key); }
    async presign(op: 'get' | 'put', key: string, ttl: number): Promise<string> {
        if (op === 'get') this.presignGetCalls++;
        return `https://fake-s3/${op}/${key}?ttl=${ttl}&t=${Date.now()}`;
    }
}

// 提取全部 img src 属性值（危险字符断言用：src 值内不得有裸 #/&/空格）
const srcs = (html: string): string[] => [...html.matchAll(/src="([^"]*)"/g)].map((m) => m[1]!);

const shareCtx = (r: { contentHash: string }, token = 'tok123', docId = 'd1', ownerId = 'u1'): ResolveCtx =>
    ({ kind: 'share', token, ownerId, docId, contentHash: r.contentHash });

describe('resolveImages——代理 URL（local 后端）', () => {
    it('share ctx → src=/s/<token>/i/<encodeURIComponent(name)>，保留 lazy/decoding，无 %%RR 残留', async () => {
        mkUser('u1');
        await mkReadyImage('u1', 'x.png', pngBytes(1));
        mkDoc('d1', 'u1');
        const r = await renderMarkdown('# t\n\n![shot](x.png)');
        const html = await resolveImages(r.html, r.names, shareCtx(r));
        expect(html).toContain('src="/s/tok123/i/x.png"');
        expect(html).toContain('loading="lazy"');
        expect(html).toContain('decoding="async"');
        expect(html).not.toContain('%%RR');
    });

    it('owner ctx → /d/<docId>/i/ 前缀', async () => {
        mkUser('u1');
        await mkReadyImage('u1', 'x.png', pngBytes(1));
        mkDoc('d1', 'u1');
        const r = await renderMarkdown('![a](x.png)');
        const html = await resolveImages(r.html, r.names, { kind: 'owner', ownerId: 'u1', docId: 'd9', contentHash: r.contentHash });
        expect(html).toContain('src="/d/d9/i/x.png"');
    });

    it('危险字符（P1-1，spec §13）：#/%/& 全编码进 URL，src 值无裸 #/&（引用侧 %23/%25 编码经 decode 对齐行名）', async () => {
        mkUser('u1');
        await mkReadyImage('u1', 'shot#a.png', pngBytes(1));
        await mkReadyImage('u1', 'a%b.png', pngBytes(2));
        await mkReadyImage('u1', 'a&b.png', pngBytes(3));
        mkDoc('d1', 'u1');
        const r = await renderMarkdown('![a](shot%23a.png)![b](a%25b.png)![c](a&b.png)');
        expect(r.names).toEqual(['shot#a.png', 'a%b.png', 'a&b.png']);
        const html = await resolveImages(r.html, r.names, shareCtx(r));
        expect(html).toContain('src="/s/tok123/i/shot%23a.png"');
        expect(html).toContain('src="/s/tok123/i/a%25b.png"');
        expect(html).toContain('src="/s/tok123/i/a%26b.png"');
        for (const s of srcs(html)) {
            expect(s).not.toContain('#');
            expect(s).not.toContain('&');
        }
        expect(html).not.toContain('shot#a.png"');
        expect(html).not.toContain('a&b.png"');
    });

    it('含空格名 → %20（init 会 sanitize 空格，直改行名模拟既有行；src 值无裸空格）', async () => {
        mkUser('u1');
        const id = await mkReadyImage('u1', 'my-shot.png', pngBytes(4));
        sqlite.exec(`UPDATE images SET name='my shot.png' WHERE id='${id}'`);
        mkDoc('d1', 'u1');
        const r = await renderMarkdown('![a](./my%20shot.png)');
        expect(r.names).toEqual(['my shot.png']);
        const html = await resolveImages(r.html, r.names, shareCtx(r));
        expect(html).toContain('src="/s/tok123/i/my%20shot.png"');
        for (const s of srcs(html)) expect(s).not.toContain(' ');
    });
});

describe('IMAGE_PROXY_ALL=1 → 全代理（presign 不调用）', () => {
    it('local 与 s3 行全部代理 URL，FakeS3 get-presign 计数 = 0', async () => {
        mkUser('u1');
        await mkReadyImage('u1', 'l.png', pngBytes(1));
        const fake = new FakeS3();
        __setBlobStoresForTest({ local: new LocalBlobStore(), s3: fake });
        await mkS3ReadyImage(fake, 'u1', 's.png', pngBytes(2));
        mkDoc('d1', 'u1');
        process.env.IMAGE_PROXY_ALL = '1';
        const r = await renderMarkdown('![l](l.png)![s](s.png)');
        const html = await resolveImages(r.html, r.names, shareCtx(r));
        expect(html).toContain('src="/s/tok123/i/l.png"');
        expect(html).toContain('src="/s/tok123/i/s.png"');
        expect(fake.presignGetCalls).toBe(0);
    });
});

describe('s3 行 → presign 直连', () => {
    it('src 为 presign URL + img 带 referrerpolicy（渲染期预置）', async () => {
        mkUser('u1');
        const fake = new FakeS3();
        __setBlobStoresForTest({ local: new LocalBlobStore(), s3: fake });
        await mkS3ReadyImage(fake, 'u1', 's.png', pngBytes(1));
        mkDoc('d1', 'u1');
        const r = await renderMarkdown('![s](s.png)');
        const html = await resolveImages(r.html, r.names, shareCtx(r));
        expect(srcs(html)[0]).toMatch(/^https:\/\/fake-s3\/get\//);
        expect(html).toContain('referrerpolicy="strict-origin-when-cross-origin"');
        expect(fake.presignGetCalls).toBe(1);
    });
});

describe('桶对齐 presign 缓存（spec §7.3 结果缓存方案）', () => {
    it('同桶两次 resolve 产出逐字节相同 URL（缓存命中不重签）；advance 到下一桶 → URL 变化（重签）', async () => {
        vi.useFakeTimers();
        try {
            delete process.env.IMAGE_SIGNED_URL_TTL; // 默认 3600 → bucketMs = 600_000
            __resetPresignCacheForTest();
            mkUser('u1');
            const fake = new FakeS3();
            __setBlobStoresForTest({ local: new LocalBlobStore(), s3: fake });
            await mkS3ReadyImage(fake, 'u1', 's.png', pngBytes(1));
            mkDoc('d1', 'u1');
            const r = await renderMarkdown('![s](s.png)');
            const resolve = (): Promise<string> => resolveImages(r.html, r.names, shareCtx(r)).then((h) => srcs(h)[0]!);
            const u1 = await resolve();
            expect(fake.presignGetCalls).toBe(1);
            const u2 = await resolve(); // 同桶：缓存命中 → 复用首签 URL
            expect(u2).toBe(u1);        // 逐字节相同 → 浏览器缓存命中
            expect(fake.presignGetCalls).toBe(1);
            await vi.advanceTimersByTimeAsync(600_000); // 下一桶
            const u3 = await resolve();
            expect(u3).not.toBe(u1);
            expect(fake.presignGetCalls).toBe(2);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('裂图占位（P0-1 双轨整标签替换）', () => {
    it('无行 → rr-img-missing span；整个 <img> 标签被吃且 alt 无标签外泄漏（强断言）', async () => {
        mkUser('u1');
        mkDoc('d1', 'u1');
        const r = await renderMarkdown('![ALTTAG](ghost.png)');
        const html = await resolveImages(r.html, r.names, shareCtx(r));
        expect(html).toContain('rr-img-missing');
        expect(html).toContain('图片不存在或未就绪');
        expect(html).not.toContain('<img');   // P0-1：整标签被吃（span 塞 src 值会截断属性破坏 HTML）
        expect(html).not.toContain('ALTTAG'); // alt 只应在被吃掉的标签内——不得以裸文本泄漏
        expect(html).not.toContain('%%RR');
    });

    it('pending 图名（init 未 relay）→ 裂图 span，同样整标签被吃', async () => {
        mkUser('u1');
        const init = await initImage('u1', { name: 'p.png', contentHash: sha256(pngBytes(1)), contentMd5: md5(pngBytes(1)), sizeBytes: pngBytes(1).length });
        expect(init.status).toBe('relay');
        mkDoc('d1', 'u1');
        const r = await renderMarkdown('![a](p.png)');
        const html = await resolveImages(r.html, r.names, shareCtx(r));
        expect(html).toContain('rr-img-missing');
        expect(html).not.toContain('<img');
    });

    it('s3 行但 store 未注册（后端移除）→ 裂图 span，title 含"存储后端"', async () => {
        mkUser('u1');
        const fake = new FakeS3();
        __setBlobStoresForTest({ local: new LocalBlobStore(), s3: fake });
        await mkS3ReadyImage(fake, 'u1', 's.png', pngBytes(1));
        __setBlobStoresForTest({ local: new LocalBlobStore() }); // s3 不注册（env 撤销等价态）
        mkDoc('d1', 'u1');
        const r = await renderMarkdown('![s](s.png)');
        const html = await resolveImages(r.html, r.names, shareCtx(r));
        expect(html).toContain('rr-img-missing');
        expect(html).toContain('存储后端');
        expect(html).not.toContain('<img');
    });

    it('裂图占位内 name 过 escapeHtml（& 断言）', async () => {
        mkUser('u1');
        mkDoc('d1', 'u1');
        const r = await renderMarkdown('![a](a&b.png)');
        const html = await resolveImages(r.html, r.names, shareCtx(r));
        expect(html).toContain('[a&amp;b.png]');
        expect(html).not.toContain('[a&b.png]');
    });

    it('裂图 name 含 $& 不被 replace 替换串语义展开（函数形式替换）', async () => {
        mkUser('u1');
        mkDoc('d1', 'u1');
        // $& 是合法文件名字符；String.replace 字符串替换串会把 $& 展开为整个匹配（img 标签）
        const r = await renderMarkdown('![a](a$&b.png)');
        const html = await resolveImages(r.html, r.names, shareCtx(r));
        expect(html).toContain('[a$&amp;b.png]');   // escapeHtml 后 $& 字面保留（非 img 标签展开）
        expect(html).not.toContain('<img');
    });
});

describe('refs 惰性补录接线（lazyRegisterRefs）', () => {
    it('resolve 后 image_refs 行存在（ready 图按名登记）', async () => {
        mkUser('u1');
        const imgId = await mkReadyImage('u1', 'x.png', pngBytes(1));
        const md = '![x](x.png)';
        const r = await renderMarkdown(md);
        mkDoc('d1', 'u1', r.contentHash); // documents.content_hash = md 源 sha256（uploadDocument 同语义）
        await resolveImages(r.html, r.names, shareCtx(r));
        const refs = db.select().from(schema.imageRefs).where(eq(schema.imageRefs.documentId, 'd1')).all();
        expect(refs.map((x) => x.imageId)).toEqual([imgId]);
    });

    it('contentHash 守卫：documents.content_hash 与渲染期不一致（渲染期间被覆盖）→ refs 不增', async () => {
        mkUser('u1');
        await mkReadyImage('u1', 'x.png', pngBytes(1));
        const r = await renderMarkdown('![x](x.png)');
        mkDoc('d1', 'u1', 'f'.repeat(64)); // 行内 hash ≠ 渲染期 hash
        await resolveImages(r.html, r.names, shareCtx(r));
        expect(db.select().from(schema.imageRefs).where(eq(schema.imageRefs.documentId, 'd1')).all()).toEqual([]);
    });
});

describe('图片引用超上限整体降级（交叉审查 P0：免登录渲染 DoS 防御）', () => {
    const HASH = 'a'.repeat(64);
    const ownerCtx = { kind: 'owner', ownerId: 'u1', docId: 'd1', contentHash: HASH } as const;

    it('names 501 → 单趟整体降级：全部 img 标签吃成统一 span，无 %%RR 残留、无 <img 泄漏', async () => {
        mkUser('u1');
        mkDoc('d1', 'u1');
        const html = `<p>pre</p>\n<img src="%%RR:IMG:aaaaaaaa:0%%" alt="i0">\n<img src="%%RR:IMG:aaaaaaaa:1%%" alt="i1">\n<p>post</p>`;
        const names = Array.from({ length: 501 }, (_, i) => `i${i}.png`);
        const out = await resolveImages(html, names, ownerCtx);
        expect(out).not.toContain('<img');
        expect(out).not.toContain('%%RR');
        expect(out).toContain('pre');
        expect(out).toContain('post');
        expect((out.match(/超过上限/g) ?? []).length).toBe(2); // 每个占位符一个降级 span
    });

    it('names 500（恰好上限）→ 不降级：走正常裂图轨道（图片不存在 span）', async () => {
        mkUser('u1');
        mkDoc('d1', 'u1');
        const html = `<img src="%%RR:IMG:aaaaaaaa:0%%" alt="i0">`;
        const names = Array.from({ length: 500 }, (_, i) => `i${i}.png`);
        const out = await resolveImages(html, names, ownerCtx);
        expect(out).toContain('图片不存在或未就绪');
        expect(out).not.toContain('超过上限');
    });
});

describe('替换完整性与防冲突', () => {
    it('混合 md（代理 + 裂图）→ 无 %%RR:IMG 残留；<img 计数 = 成功图数（裂图零残段）', async () => {
        mkUser('u1');
        await mkReadyImage('u1', 'ok.png', pngBytes(1));
        mkDoc('d1', 'u1');
        const r = await renderMarkdown('# mix\n\n![ok](ok.png) text ![g](ghost.png) tail');
        const html = await resolveImages(r.html, r.names, shareCtx(r));
        expect(html).not.toContain('%%RR:IMG');
        expect(html.match(/<img\b/g)?.length ?? 0).toBe(1); // 裂图标签被整吃，仅成功图留 <img
        expect(html).toContain('src="/s/tok123/i/ok.png"');
        expect(html).toContain('rr-img-missing');
    });

    it('伪造占位符 %%RR:IMG:deadbeef:0%%（hash 段不同于真实内容 hash）→ 原样保留', async () => {
        mkUser('u1');
        await mkReadyImage('u1', 'x.png', pngBytes(1));
        mkDoc('d1', 'u1');
        const r = await renderMarkdown('![a](x.png) %%RR:IMG:deadbeef:0%%');
        const html = await resolveImages(r.html, r.names, shareCtx(r));
        expect(html).toContain('%%RR:IMG:deadbeef:0%%'); // 伪造串原样（自指不可能构造的验证）
        expect(html).toContain('src="/s/tok123/i/x.png"'); // 真实占位符照常替换
    });
});
