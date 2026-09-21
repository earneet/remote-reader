import { test, expect, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ApiClient } from '../api-client';
import { ImageValidationError } from './image-pipeline';
import {
    uploadDocumentHandler,
    uploadDocumentSchema,
    uploadDocumentDescription
} from './upload-document';

function mockApi() {
    return {
        uploadDocument: vi.fn(),
        initImage: vi.fn(),
        relayImage: vi.fn(),
        confirmImage: vi.fn(),
        putImageBytes: vi.fn()
    };
}
const asApi = (m: ReturnType<typeof mockApi>): ApiClient => m as unknown as ApiClient;

test('description 非空且引导把 url 发给用户', () => {
    expect(uploadDocumentDescription).toBeTruthy();
    expect(uploadDocumentDescription).toContain('url');
});

test('schema 接受 name+content（无 path）', () => {
    expect(uploadDocumentSchema.safeParse({ name: 'a.md', content: 'x' }).success).toBe(true);
});

test('schema 接受带 path', () => {
    expect(uploadDocumentSchema.safeParse({ name: 'a.md', content: 'x', path: 'r' }).success).toBe(true);
});

test('schema 拒绝缺 name', () => {
    expect(uploadDocumentSchema.safeParse({ content: 'x' }).success).toBe(false);
});

test('handler 透传参数并返回 MCP 结果形状', async () => {
    const m = mockApi();
    m.uploadDocument.mockResolvedValue({ id: 'd1', url: 'http://s/t' });
    const r = await uploadDocumentHandler({ name: 'a.md', content: 'c', path: 'p' }, asApi(m));
    expect(m.uploadDocument).toHaveBeenCalledWith({ name: 'a.md', content: 'c', path: 'p' });
    expect(r.content[0]).toMatchObject({ type: 'text' });
    expect(r.content[0].text).toContain('http://s/t');
});

test('无图 md：行为与现状逐字一致，图片 API 计数全为 0', async () => {
    const m = mockApi();
    m.uploadDocument.mockResolvedValue({ id: 'd1', url: 'http://s/t' });
    const r = await uploadDocumentHandler({ name: 'a.md', content: '# hi\n纯文本' }, asApi(m));
    expect(r.content[0].text).toBe('已上传（id=d1）。查看链接：http://s/t');
    expect(m.initImage).toHaveBeenCalledTimes(0);
    expect(m.relayImage).toHaveBeenCalledTimes(0);
    expect(m.confirmImage).toHaveBeenCalledTimes(0);
    expect(m.putImageBytes).toHaveBeenCalledTimes(0);
});

test('handler 透传 api 错误（不吞）', async () => {
    const m = mockApi();
    m.uploadDocument.mockRejectedValue(new Error('boom'));
    await expect(uploadDocumentHandler({ name: 'a', content: 'b' }, asApi(m))).rejects.toThrow('boom');
});

test('带图 md（tmpdir 真 PNG）：全流程 → 文本含图片摘要，改写后 content 传给 uploadDocument', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'rr-updoc-'));
    const p = join(dir, 'shot.png');
    await writeFile(p, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00]));
    try {
        const m = mockApi();
        m.initImage.mockResolvedValue({ status: 'direct', name: 'n.png', imageId: 'i1', uploadUrl: 'http://put' });
        m.confirmImage.mockResolvedValue({ status: 'ok', name: 'reg-1.png' });
        m.uploadDocument.mockResolvedValue({ id: 'd9', url: 'http://s/t9' });
        const r = await uploadDocumentHandler({ name: 'a.md', content: `![x](${p})` }, asApi(m));
        expect(r.content[0].text).toBe('已上传（id=d9）。查看链接：http://s/t9。图片：新传 1 · 复用 0 · 引用改写 1 处');
        expect(m.putImageBytes).toHaveBeenCalledWith('http://put', expect.any(Buffer));
        // 引用已是服务器注册名（非请求名/原路径）
        expect(m.uploadDocument).toHaveBeenCalledWith({ name: 'a.md', content: '![x](reg-1.png)' });
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('图片引用超上限（501 名）→ 预检入口直接拒绝，零 API 调用（先于文件 IO）', async () => {
    const m = mockApi();
    m.uploadDocument.mockResolvedValue({ id: 'd1', url: 'http://s/t' });
    const md = Array.from({ length: 501 }, (_, i) => `![i](missing-${i}.png)`).join('\n');
    await expect(uploadDocumentHandler({ name: 'a.md', content: md }, asApi(m))).rejects.toThrow('图片引用超过上限');
    expect(m.uploadDocument).toHaveBeenCalledTimes(0);
    expect(m.initImage).toHaveBeenCalledTimes(0);
});

test('预检失败：throw ImageValidationError（多行问题清单），零上传', async () => {
    const m = mockApi();
    m.uploadDocument.mockResolvedValue({ id: 'd1', url: 'http://s/t' });
    let err: unknown;
    try {
        await uploadDocumentHandler({ name: 'a.md', content: '![x](definitely-missing-rr-test.png)' }, asApi(m));
    } catch (e) {
        err = e;
    }
    expect(err).toBeInstanceOf(ImageValidationError);
    const msg = (err as Error).message;
    expect(msg).toContain('[1/1] FILE_NOT_FOUND: "definitely-missing-rr-test.png"');
    expect(msg.split('\n').length).toBeGreaterThan(2);
    expect(m.initImage).toHaveBeenCalledTimes(0);
    expect(m.uploadDocument).toHaveBeenCalledTimes(0);
});
