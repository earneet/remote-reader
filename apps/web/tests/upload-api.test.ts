import { test, expect, beforeEach } from 'vitest';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateApiToken, generateId, hashPassword } from '../src/lib/server/auth';

// 413 测试需要小上限；限流放宽避免测试间互相触发——须在 import +server 前设
process.env.MAX_UPLOAD_BYTES = '10';
process.env.RATE_LIMIT_MAX = '10000';
process.env.AUTH_FAIL_RATE_LIMIT_MAX = '3';
const { POST } = await import('../src/routes/api/v1/documents/+server');

let validAuth: string;

function makeEvent(headers: Record<string, string>, body: unknown, address = '127.0.0.1') {
    const request = new Request('http://localhost/api/v1/documents', {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });
    return { request, getClientAddress: () => address } as Parameters<typeof POST>[0];
}

async function call(headers: Record<string, string>, body: unknown, address?: string) {
    try {
        const r = await POST(makeEvent(headers, body, address));
        return { status: r.status, body: await r.json().catch(() => null) };
    } catch (e) {
        return { status: (e as { status?: number })?.status ?? 500, body: (e as { body?: unknown })?.body ?? null };
    }
}

beforeEach(async () => {
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
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
        id: generateId(),
        userId: ownerId,
        name: 'test',
        tokenHash: t.hash,
        createdAt: Date.now()
    }).run();
    validAuth = `Bearer ${t.plaintext}`;
});

test('无 auth → 401', async () => {
    expect((await call({}, { name: 'a.md', content: 'x' })).status).toBe(401);
});

test('错 token → 401', async () => {
    expect((await call({ authorization: 'Bearer rr_wrong' }, { name: 'a.md', content: 'x' })).status).toBe(401);
});

test('合法上传 → 200 返回 {id,url}', async () => {
    const r = await call({ authorization: validAuth }, { name: 'a.md', content: '# hi' });
    expect(r.status).toBe(200);
    expect(r.body.id).toBeTruthy();
    expect(r.body.url).toMatch(/\/s\//);
});

test('content 超 MAX_BYTES → 413', async () => {
    const r = await call({ authorization: validAuth }, { name: 'a.md', content: 'x'.repeat(50) });
    expect(r.status).toBe(413);
});

test('缺 name → 400', async () => {
    expect((await call({ authorization: validAuth }, { content: 'x' })).status).toBe(400);
});

test('content 非 string → 400', async () => {
    expect((await call({ authorization: validAuth }, { name: 'a.md', content: 123 })).status).toBe(400);
});

test('非法 json → 400', async () => {
    expect((await call({ authorization: validAuth }, '{not json')).status).toBe(400);
});

test('name 含 .. 路径穿越 → 400（H5）', async () => {
    const r = await call({ authorization: validAuth }, { name: '../../../etc/passwd', content: 'x' });
    expect(r.status).toBe(400);
});

test('path 含 .. 路径穿越 → 400（H5）', async () => {
    const r = await call({ authorization: validAuth }, { name: 'a.md', path: '../escape', content: 'x' });
    expect(r.status).toBe(400);
});

test('幂等：同内容同 name 再传返回同 id', async () => {
    const a = await call({ authorization: validAuth }, { name: 'dup.md', content: 'same' });
    const b = await call({ authorization: validAuth }, { name: 'dup.md', content: 'same' });
    expect(a.body.id).toBe(b.body.id);
});

test('同 IP 连续无效 token 触发认证失败限流 → 429', async () => {
    const ip = '9.9.9.9';
    for (let i = 0; i < 3; i++) {
        expect((await call({ authorization: 'Bearer rr_wrong' }, { name: 'a.md', content: 'x' }, ip)).status).toBe(401);
    }
    expect((await call({ authorization: 'Bearer rr_wrong' }, { name: 'a.md', content: 'x' }, ip)).status).toBe(429);
});
