import { test, expect, vi, beforeEach } from 'vitest';
import { createApiClient, ApiError, IMAGE_TIMEOUT_MS } from './api-client';

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

test('400 携带服务端 message（SvelteKit error() 真实 wire 形状 {"message":...}）', async () => {
    mockFetch(400, { message: 'path contains illegal characters' });
    await expect(
        createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: '../x', content: 'c' })
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('path contains illegal characters') });
});

test('400 兼容历史 error:{message} 形状', async () => {
    mockFetch(400, { error: { message: 'invalid path' } });
    await expect(
        createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: '../x', content: 'c' })
    ).rejects.toMatchObject({ status: 400, message: expect.stringContaining('invalid path') });
});

test('401 / 413 / 429 映射', async () => {
    for (const s of [401, 413, 429]) {
        mockFetch(s, {});
        await expect(
            createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: 'n', content: 'c' })
        ).rejects.toMatchObject({ status: s });
    }
});

test('409 冲突透传服务端 message（Agent 才知道该换 path，B2 回归）', async () => {
    mockFetch(409, { message: '路径段 "reports" 已被同名文件占用，无法作为目录' });
    await expect(
        createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: 'n', content: 'c' })
    ).rejects.toMatchObject({ status: 409, message: expect.stringContaining('已被同名文件占用') });
});

test('409 无 message → 保留状态码兜底文案', async () => {
    mockFetch(409, {});
    await expect(
        createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: 'n', content: 'c' })
    ).rejects.toMatchObject({ status: 409, message: '上传失败：HTTP 409' });
});

test('网络错误映射为 ApiError(status=0)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
        throw new Error('ENOTFOUND');
    }));
    await expect(
        createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: 'n', content: 'c' })
    ).rejects.toMatchObject({ status: 0 });
});

test('请求携带 AbortSignal 超时信号', async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
        signal = init.signal as AbortSignal;
        return new Response(JSON.stringify({ id: 'd', url: 'u' }), { status: 200 });
    }));
    await createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: 'n', content: 'c' });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal!.aborted).toBe(false);
});

test('超时中断（TimeoutError）映射为 ApiError(0, 上传超时)', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => {
        throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' });
    }));
    await expect(
        createApiClient({ baseUrl: 'http://x', token: 't' }).uploadDocument({ name: 'n', content: 'c' })
    ).rejects.toMatchObject({ status: 0, message: expect.stringContaining('上传超时') });
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

test('initImage 三态透传（exists/relay/direct）+ body 键名 snake_case + Bearer + AbortSignal', async () => {
    const replies = [
        { status: 'exists', name: 'a.png' },
        { status: 'relay', name: 'a.png', imageId: 'img_1' },
        { status: 'direct', name: 'a.png', imageId: 'img_1', uploadUrl: 'https://cloud/u?sig' }
    ];
    const bodies: string[] = [];
    let url = '';
    let headers: Record<string, string> = {};
    let signal: AbortSignal | undefined;
    let i = 0;
    vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit) => {
        url = u;
        bodies.push(init.body as string);
        headers = init.headers as Record<string, string>;
        signal = init.signal as AbortSignal;
        return new Response(JSON.stringify(replies[i++]), { status: 200 });
    }));
    const api = createApiClient({ baseUrl: 'http://x', token: 'rr_t' });
    const input = { name: 'a.png', contentHash: 'sha256hex', contentMd5: 'md5hex', sizeBytes: 4096 };
    expect(await api.initImage(input)).toEqual({ status: 'exists', name: 'a.png' });
    expect(await api.initImage(input)).toEqual({ status: 'relay', name: 'a.png', imageId: 'img_1' });
    expect(await api.initImage(input)).toEqual({ status: 'direct', name: 'a.png', imageId: 'img_1', uploadUrl: 'https://cloud/u?sig' });
    expect(url).toBe('http://x/api/v1/images/init');
    expect(headers['Authorization']).toBe('Bearer rr_t');
    expect(signal).toBeInstanceOf(AbortSignal);
    // P1-3：wire 键名 snake_case（与 Phase 2 路由对齐）——mock 拦不住键名错误，此处是唯一防线
    for (const b of bodies) {
        expect(JSON.parse(b)).toEqual({ name: 'a.png', content_hash: 'sha256hex', content_md5: 'md5hex', size_bytes: 4096 });
    }
    expect(bodies.length).toBe(3);
});

test('initImage 400/401/413 message 透传映射', async () => {
    const api = createApiClient({ baseUrl: 'http://x', token: 't' });
    const input = { name: 'a.png', contentHash: 'h', contentMd5: 'm', sizeBytes: 1 };
    mockFetch(400, { message: 'name, content_hash, content_md5, size_bytes required' });
    await expect(api.initImage(input)).rejects.toMatchObject({ status: 400, message: expect.stringContaining('required') });
    mockFetch(401, { message: 'invalid or missing api token' });
    await expect(api.initImage(input)).rejects.toMatchObject({ status: 401 });
    mockFetch(413, { message: 'too large' });
    await expect(api.initImage(input)).rejects.toMatchObject({ status: 413 });
});

test('initImage 429 → retryAfter 取 Retry-After 秒数；无头/非数字 → undefined', async () => {
    const input = { name: 'a.png', contentHash: 'h', contentMd5: 'm', sizeBytes: 1 };
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{"message":"rate limit exceeded"}', {
        status: 429, headers: { 'Retry-After': '7' }
    })));
    await expect(createApiClient({ baseUrl: 'http://x', token: 't' }).initImage(input))
        .rejects.toMatchObject({ status: 429, retryAfter: 7 });
    for (const headers of [undefined, { 'Retry-After': 'soon' }]) {
        vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 429, headers })));
        const err = await createApiClient({ baseUrl: 'http://x', token: 't' }).initImage(input).catch((e: ApiError) => e);
        expect(err).toBeInstanceOf(ApiError);
        expect(err.status).toBe(429);
        expect(err.retryAfter).toBeUndefined();
    }
});

test('relayImage 成功 {name} + body 键名 snake_case', async () => {
    let body = '';
    let url = '';
    vi.stubGlobal('fetch', vi.fn(async (u: string, init: RequestInit) => {
        url = u;
        body = init.body as string;
        return new Response(JSON.stringify({ name: 'a-2.png' }), { status: 200 });
    }));
    const r = await createApiClient({ baseUrl: 'http://x', token: 't' }).relayImage({ imageId: 'img_1', contentBase64: 'QUJD' });
    expect(r).toEqual({ name: 'a-2.png' });
    expect(url).toBe('http://x/api/v1/images');
    expect(JSON.parse(body)).toEqual({ image_id: 'img_1', content_base64: 'QUJD' });
});

test('relayImage 404 → ApiError(404)；400 invalid → reason 透传而非 message（P2-1）', async () => {
    const api = createApiClient({ baseUrl: 'http://x', token: 't' });
    mockFetch(404, { message: 'image not found' });
    await expect(api.relayImage({ imageId: 'x', contentBase64: 'QQ==' })).rejects.toMatchObject({ status: 404 });
    mockFetch(400, { status: 'invalid', reason: 'sha256 mismatch: relayed bytes differ from init' });
    await expect(api.relayImage({ imageId: 'x', contentBase64: 'QQ==' }))
        .rejects.toMatchObject({ status: 400, message: expect.stringContaining('sha256 mismatch') });
});

test('confirmImage {status:ok,name} + body 键名；404 missing / 400 invalid', async () => {
    let body = '';
    vi.stubGlobal('fetch', vi.fn(async (_u: string, init: RequestInit) => {
        body = init.body as string;
        return new Response(JSON.stringify({ status: 'ok', name: 'a.png' }), { status: 200 });
    }));
    const api = createApiClient({ baseUrl: 'http://x', token: 't' });
    expect(await api.confirmImage({ imageId: 'img_9' })).toEqual({ status: 'ok', name: 'a.png' });
    expect(JSON.parse(body)).toEqual({ image_id: 'img_9' });
    mockFetch(404, { status: 'missing' });
    await expect(api.confirmImage({ imageId: 'img_9' })).rejects.toMatchObject({ status: 404 });
    mockFetch(400, { status: 'invalid', reason: 'no bytes at storage key' });
    await expect(api.confirmImage({ imageId: 'img_9' }))
        .rejects.toMatchObject({ status: 400, message: expect.stringContaining('no bytes at storage key') });
});

test('putImageBytes：PUT 二进制 body + 无 Authorization/Content-Type 头（P1-2 presigned 直传）', async () => {
    let captured: { url?: string; init?: RequestInit } = {};
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return new Response(null, { status: 204 });
    }));
    const buf = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    await createApiClient({ baseUrl: 'http://x', token: 'rr_secret' })
        .putImageBytes('https://cloud.example.com/b/k?X-Amz-Signature=s', buf);
    expect(captured.url).toBe('https://cloud.example.com/b/k?X-Amz-Signature=s');
    expect(captured.init!.method).toBe('PUT');
    expect(captured.init!.body).toEqual(new Uint8Array(buf));
    const headers = (captured.init!.headers ?? {}) as Record<string, string>;
    expect(headers.Authorization ?? headers.authorization).toBeUndefined();
    expect(headers['Content-Type'] ?? headers['content-type']).toBeUndefined();
});

test('putImageBytes 非 2xx → ApiError 图片直传失败', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<Error><Code>AccessDenied</Code></Error>', { status: 403 })));
    await expect(createApiClient({ baseUrl: 'http://x', token: 't' }).putImageBytes('https://c/u', Buffer.from('x')))
        .rejects.toMatchObject({ status: 403, message: expect.stringContaining('图片直传失败') });
});

test('图片方法超时 = IMAGE_TIMEOUT_MS 300s（spec §6.2 慢链路常量锁定）', async () => {
    expect(IMAGE_TIMEOUT_MS).toBe(300_000);
});
