import { test, expect, beforeEach, afterAll } from 'vitest';
import { db, schema } from '../src/lib/server/db';
import { generateApiToken, generateId, hashPassword } from '../src/lib/server/auth';
import { resetDb } from './helpers';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// 显式设置 5MB 上限（恰等于 env.ts 默认值）：+server 的 MAX_BYTES 在模块加载时读 env，
// 须在 import 前设置；显式化使 413 断言不依赖默认值漂移。
// （历史注释称 upload-api 顶层 env 会“跨文件泄漏到本文件”——实测 vitest 4 每文件独立
// fork、env 逐文件隔离，该泄漏不存在；显式设置保留仅为密闭性，非防泄漏）
process.env.MAX_UPLOAD_BYTES = String(5 * 1024 * 1024);
process.env.RATE_LIMIT_MAX = '10000';
const { POST } = await import('../src/routes/api/v1/documents/+server');

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-imglimit-'));
process.env.DATA_DIR = DIR;
afterAll(() => {
    delete process.env.DATA_DIR;
    delete process.env.MAX_UPLOAD_BYTES;
    fs.rmSync(DIR, { recursive: true, force: true });
});

let validAuth: string;

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
        return { status: r.status, body: await r.json().catch(() => null) };
    } catch (e) {
        return { status: (e as { status?: number })?.status ?? 500, body: (e as { body?: unknown })?.body ?? null };
    }
}

beforeEach(async () => {
    resetDb();
    const ownerId = generateId();
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

const mdWithRefs = (n: number): string =>
    Array.from({ length: n }, (_, i) => `![i${i}](i${i}.png)`).join('\n');

test('501 个互异图片名 → 413 且 message 含"图片引用超过上限"', async () => {
    const r = await call({ authorization: validAuth }, { name: 'big.md', content: mdWithRefs(501) });
    expect(r.status).toBe(413);
    expect((r.body as { message?: string }).message).toContain('图片引用超过上限');
});

test('500 个互异图片名（恰好上限）→ 200 正常上传', async () => {
    const r = await call({ authorization: validAuth }, { name: 'cap.md', content: mdWithRefs(500) });
    expect(r.status).toBe(200);
    expect((r.body as { url?: string }).url).toMatch(/\/s\//);
});
