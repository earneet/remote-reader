import { test, expect, vi, beforeEach } from 'vitest';
import { createApiClient, ApiError } from './api-client';

beforeEach(() => {
    vi.unstubAllGlobals();
});

function mockFetch(status: number, body: unknown) {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' }
    })));
}

test('uploadDocument 构造正确请求并解析响应', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response(JSON.stringify({ id: 'd1', url: 'http://x/s/t' }), { status: 200 });
    }));
    const api = createApiClient({ baseUrl: 'https://app.example.com/', token: 'rr_abc' });
    const r = await api.uploadDocument({ name: 'a.md', content: 'x', path: 'p' });
    expect(r).toEqual({ id: 'd1', url: 'http://x/s/t' });
    expect(captured.url).toBe('https://app.example.com/api/v1/documents');
    expect(captured.init!.method).toBe('POST');
    expect((captured.init!.headers as Record<string, string>)['Authorization']).toBe('Bearer rr_abc');
    expect(JSON.parse(captured.init!.body as string)).toEqual({ name: 'a.md', content: 'x', path: 'p' });
});

test('无 path 时 body 不含 path', async () => {
    let body: string | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
        body = init.body as string;
        return new Response(JSON.stringify({ id: 'd', url: 'u' }), { status: 200 });
    }));
    await createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: 'n', content: 'c' });
    expect(JSON.parse(body!)).toEqual({ name: 'n', content: 'c' });
});

test('baseUrl 去尾斜杠', async () => {
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string) => {
        url = u;
        return new Response('{"id":"1","url":"u"}', { status: 200 });
    }));
    await createApiClient({ baseUrl: 'http://x///', token: 't' }).uploadDocument({ name: 'n', content: 'c' });
    expect(url).toBe('http://x/api/v1/documents');
});

test('400 映射为 ApiError(400)', async () => {
    mockFetch(400, { type: 'error', error: { message: 'invalid path' } });
    await expect(
        createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: '../x', content: 'c' })
    ).rejects.toMatchObject({ status: 400 });
});

test('401 / 413 / 429 映射', async () => {
    for (const s of [401, 413, 429]) {
        mockFetch(s, {});
        await expect(
            createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: 'n', content: 'c' })
        ).rejects.toMatchObject({ status: s });
    }
});

test('网络错误映射为 ApiError(status=0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error('ENOTFOUND');
    }));
    await expect(
        createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: 'n', content: 'c' })
    ).rejects.toMatchObject({ status: 0 });
});

test('200 但缺 url → ApiError 响应格式异常（#34）', async () => {
    mockFetch(200, { id: 'd' });
    await expect(
        createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: 'n', content: 'c' })
    ).rejects.toMatchObject({ status: 200 });
});

test('200 但 body 非 json → ApiError（#34）', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html>not json</html>', { status: 200 })));
    await expect(
        createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: 'n', content: 'c' })
    ).rejects.toMatchObject({ status: 200 });
});
