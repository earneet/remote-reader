import { test, expect, beforeEach, afterAll } from 'vitest';
import { db, schema } from '../src/lib/server/db';
import { generateApiToken, generateId, hashPassword } from '../src/lib/server/auth';
import { resetDb } from './helpers';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 显式设置 5MB 上限（恰等于 env.ts 默认值）：+server 的 MAX_BYTES 在模块加载时读 env，
// 须在 import 前设置；显式化使断言不依赖默认值漂移（“防 upload-api 顶层 env 泄漏”的
// 历史说法不成立——vitest 4 每文件独立 fork，env 逐文件隔离）
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

test('弯引号手写锚点文档（2026-09-28 事故形态）→ 200 + warnings 提及锚点 id 与标题锚点修正指引', async () => {
    const content = [
        '# 手册',
        '',
        '## 章节地图',
        '',
        '| 章 | 链接 |',
        '|---|---|',
        '| 1 | [第一章](#ch1) |',
        '',
        '<a id=“ch1”></a>',
        '',
        '## 第一章 概述'
    ].join('\n');
    const r = await call({ authorization: validAuth }, { name: 'anchors.md', content });
    expect(r.status).toBe(200);
    const warnings = (r.body as { warnings?: string[] }).warnings;
    expect(warnings).toHaveLength(1);
    expect(warnings![0]).toContain('ch1');
    expect(warnings![0]).toContain('标题');
    expect(warnings![0]).toContain('重新上传');
});

test('锚点 + 未上传图片引用同时存在 → warnings 2 条（各检测器独立成条，不合并）', async () => {
    const r = await call({ authorization: validAuth }, {
        name: 'both.md',
        content: '<a id="top"></a>\n\n![x](imgs/red.png)'
    });
    expect(r.status).toBe(200);
    const warnings = (r.body as { warnings?: string[] }).warnings;
    expect(warnings).toHaveLength(2);
    expect(warnings!.some((w) => w.includes('imgs/red.png'))).toBe(true);
    expect(warnings!.some((w) => w.includes('top') && w.includes('锚点'))).toBe(true);
});

test('锚点超 5 个 → 计数报全量 7 处、仅列前 5（与图片检测同款截断语义）', async () => {
    const content = Array.from({ length: 7 }, (_, i) => `<a id="sec${i}"></a>`).join('\n');
    const r = await call({ authorization: validAuth }, { name: 'many-a.md', content });
    expect(r.status).toBe(200);
    const msg = ((r.body as { warnings?: string[] }).warnings ?? [])[0] ?? '';
    expect(msg).toContain('检测到 7 处');
    expect(msg).toContain('sec0');
    expect(msg).toContain('sec4');
    expect(msg).not.toContain('sec5');
});

test('代码块内的锚点教学示例 → 无 warnings 键（不误报，响应形状零变化）', async () => {
    const content = '# 教学\n\n```html\n<a id="demo"></a>\n```\n\n行内 `<a id="x"></a>` 也不算';
    const r = await call({ authorization: validAuth }, { name: 'teach.md', content });
    expect(r.status).toBe(200);
    expect('warnings' in (r.body ?? {})).toBe(false);
});

test('幂等重传同内容 → warnings 每次响应都携带（修正前的每次上传都被提醒）', async () => {
    const body = { name: 'idem.md', content: '<a id="top"></a>' };
    const first = await call({ authorization: validAuth }, body);
    const second = await call({ authorization: validAuth }, body);
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect((first.body as { warnings?: string[] }).warnings).toHaveLength(1);
    expect((second.body as { warnings?: string[] }).warnings).toHaveLength(1);
});
