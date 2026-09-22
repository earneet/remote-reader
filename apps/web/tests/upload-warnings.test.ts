import { test, expect, beforeEach, afterAll } from 'vitest';
import { db, schema } from '../src/lib/server/db';
import { generateApiToken, generateId, hashPassword } from '../src/lib/server/auth';
import { resetDb } from './helpers';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// upload-api.test.ts 顶层把 MAX_UPLOAD_BYTES 固化泄漏为 '10'（singleFork 同进程），带图片引用的
// content 必超 10B——按 upload-image-limit.test.ts 先例，在 import +server 之前用真实上限覆写
process.env.MAX_UPLOAD_BYTES = String(5 * 1024 * 1024);
process.env.RATE_LIMIT_MAX = '10000';
const { POST } = await import('../src/routes/api/v1/documents/+server');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-upwarn-'));
process.env.DATA_DIR = DIR;
afterAll(() => {
    delete process.env.DATA_DIR;
    delete process.env.MAX_UPLOAD_BYTES;
    fs.rmSync(DIR, { recursive: true, force: true });
});

let validAuth: string;
let ownerId: string;

function makeEvent(headers: Record<string, string>, body: unknown) {
    const request = new Request('http://localhost/api/v1/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body)
    });
    return { request, getClientAddress: () => '127.0.0.1' } as Parameters<typeof POST>[0];
}

async function call(headers: Record<string, string>, body: unknown) {
    try {
        const r = await POST(makeEvent(headers, body));
        return { status: r.status, headers: r.headers, body: await r.json().catch(() => null) };
    } catch (e) {
        return { status: (e as { status?: number })?.status ?? 500, headers: new Headers(), body: (e as { body?: unknown })?.body ?? null };
    }
}

beforeEach(async () => {
    resetDb();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId,
        email: `t-${Date.now()}@x.com`,
        passwordHash: await hashPassword('x'),
        role: 'member',
        createdAt: Date.now()
    }).run();
    const t = await generateApiToken();
    db.insert(schema.apiTokens).values({
        id: generateId(), userId: ownerId, name: 'test', tokenHash: t.hash, createdAt: Date.now()
    }).run();
    validAuth = `Bearer ${t.plaintext}`;
});

// 直插一条 owner 的 ready 图行：detector 只读 image_refs JOIN images，无需真实盘上 blob
function seedReadyImage(name: string): void {
    const now = Date.now();
    db.insert(schema.images).values({
        id: generateId(),
        ownerId,
        name,
        contentHash: `${name}-hash`,
        contentMd5: `${name}-md5`,
        mimeType: 'image/png',
        sizeBytes: 100,
        status: 'ready',
        storageBackend: 'local',
        storageKey: `images/${name}`,
        createdAt: now,
        readyAt: now
    }).run();
}

test('旧桥风格 md（![x](imgs/red.png)，含重复引用去重）→ 200 + warnings 提及 imgs/red.png', async () => {
    const r = await call({ authorization: validAuth }, {
        name: 'old-bridge.md',
        content: '# 旧桥\n\n![x](imgs/red.png)\n\n![y](imgs/red.png)'
    });
    expect(r.status).toBe(200);
    const warnings = (r.body as { warnings?: unknown }).warnings;
    expect(Array.isArray(warnings)).toBe(true);
    expect(warnings).toHaveLength(1);
    expect((warnings as string[])[0]).toContain('imgs/red.png');
    expect((warnings as string[])[0]).toContain('桥版本过旧');
});

test('裸名引用已登记（预置 ready 图 + 上传时 registerDocumentRefs）→ 无 warnings 键', async () => {
    seedReadyImage('red.png');
    const r = await call({ authorization: validAuth }, {
        name: 'new-bridge.md',
        content: '# 新桥\n\n![x](red.png)'
    });
    expect(r.status).toBe(200);
    expect(r.body.id).toBeTruthy();
    expect('warnings' in (r.body ?? {})).toBe(false);
});

test('裸名引用未登记（无对应图行）→ 仍计入 warnings', async () => {
    const r = await call({ authorization: validAuth }, {
        name: 'ghost.md',
        content: '![x](red.png)'
    });
    expect(r.status).toBe(200);
    expect((r.body as { warnings?: string[] }).warnings).toHaveLength(1);
});

test('成功响应携带 x-remote-reader-min-bridge: 0.2.0（有无 warnings 两路）', async () => {
    const clean = await call({ authorization: validAuth }, { name: 'a.md', content: '# hi' });
    expect(clean.status).toBe(200);
    expect(clean.headers.get('x-remote-reader-min-bridge')).toBe('0.2.0');
    const warned = await call({ authorization: validAuth }, { name: 'b.md', content: '![x](imgs/red.png)' });
    expect(warned.status).toBe(200);
    expect(warned.headers.get('x-remote-reader-min-bridge')).toBe('0.2.0');
});

test('纯文本文档 → 无 warnings 键（响应形状零变化）', async () => {
    const r = await call({ authorization: validAuth }, { name: 'plain.md', content: '# hi\n纯文本' });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ id: expect.any(String), url: expect.stringContaining('/s/') });
});

test('可疑引用超 5 个 → warnings 计数报全量 7 处、仅列前 5（消息长度上限）', async () => {
    const content = Array.from({ length: 7 }, (_, i) => `![i${i}](imgs/i${i}.png)`).join('\n');
    const r = await call({ authorization: validAuth }, { name: 'many.md', content });
    expect(r.status).toBe(200);
    const msg = ((r.body as { warnings?: string[] }).warnings ?? [])[0] ?? '';
    expect(msg).toContain('检测到 7 处');
    expect(msg).toContain('仅列前 5 处');
    expect(msg).toContain('imgs/i0.png');
    expect(msg).toContain('imgs/i4.png');
    expect(msg).not.toContain('imgs/i5.png');
    expect(msg).not.toContain('imgs/i6.png');
});
