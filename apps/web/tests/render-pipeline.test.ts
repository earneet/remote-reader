import { test, expect, beforeEach, afterEach, afterAll } from 'vitest';
import { rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { db, schema } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';
import { initImage, relayImage } from '../src/lib/server/images';
import { createShareLink } from '../src/lib/server/shares';
import { LocalBlobStore } from '../src/lib/server/blobstore-local';
import { __setBlobStoresForTest } from '../src/lib/server/blobstore';
import { resetDb } from './helpers';

// 渲染管线端到端（Task 5 接线）：渲染阶段占位符 → 替换阶段 URL 决策——/s/ 与 /d/ 两 ctx + 裂图
const shareLoad = (await import('../src/routes/s/[token]/+page.server')).load;
const ownerLoad = (await import('../src/routes/d/[id]/+page.server')).load;

const TMP = `./data/test-renderpipe-${Date.now().toString(36)}`;
let ownerId: string;

beforeEach(() => {
    process.env.DATA_DIR = TMP;
    resetDb();
    __setBlobStoresForTest({ local: new LocalBlobStore() });
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId, email: `t-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
});

afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});
afterAll(() => { __setBlobStoresForTest(undefined); });

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex');

// 正路建 ready 图（initImage + relayImage，同 image-refs.test.ts 模式）
async function mkReadyImage(name: string, data: Buffer): Promise<void> {
    const init = await initImage(ownerId, { name, contentHash: sha256(data), contentMd5: md5(data), sizeBytes: data.length });
    if (init.status === 'exists') throw new Error(`mkReadyImage 撞去重池（${name}）`);
    const r = await relayImage(ownerId, init.imageId, data);
    if (!r.ok) throw new Error(`mkReadyImage relay 失败: ${JSON.stringify(r)}`);
}

function callShareLoad(token: string) {
    return shareLoad({ locals: { user: null }, params: { token }, setHeaders: () => {} } as unknown as Parameters<typeof shareLoad>[0]);
}
function callOwnerLoad(docId: string) {
    return ownerLoad({ locals: { user: { id: ownerId } }, params: { id: docId }, setHeaders: () => {} } as unknown as Parameters<typeof ownerLoad>[0]);
}

test('/s/ share ctx：正路上传带图 md → html 含 /s/<token>/i/<name> 代理 URL 且无 %%RR 残留', async () => {
    await mkReadyImage('shot.png', PNG);
    const r = await uploadDocument(ownerId, 'img.md', '# 带图\n\n![shot](shot.png)', []);
    const { token } = await createShareLink(r.id);
    const result = (await callShareLoad(token)) as { html: string };
    expect(result.html).toContain(`src="/s/${token}/i/shot.png"`);
    expect(result.html).not.toContain('%%RR');
});

test('/d/ owner ctx：同构 → /d/<docId>/i/<name> 且无 %%RR 残留', async () => {
    await mkReadyImage('shot.png', PNG);
    const r = await uploadDocument(ownerId, 'img.md', '# owner 视图\n\n![shot](shot.png)', []);
    const result = (await callOwnerLoad(r.id)) as { html: string };
    expect(result.html).toContain(`src="/d/${r.id}/i/shot.png"`);
    expect(result.html).not.toContain('%%RR');
});

test('裂图 md（引用不存在名）→ rr-img-missing 占位且无 <img 残留', async () => {
    const r = await uploadDocument(ownerId, 'broken.md', '正文 ![g](ghost.png)', []);
    const { token } = await createShareLink(r.id);
    const result = (await callShareLoad(token)) as { html: string };
    expect(result.html).toContain('rr-img-missing');
    expect(result.html).not.toContain('<img');
    expect(result.html).not.toContain('%%RR');
});
