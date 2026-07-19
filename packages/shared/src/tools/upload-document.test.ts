import { test, expect, vi } from 'vitest';
import {
    uploadDocumentHandler,
    uploadDocumentSchema,
    uploadDocumentDescription
} from './upload-document';

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
    const api = { uploadDocument: vi.fn(async () => ({ id: 'd1', url: 'http://s/t' })) };
    const r = await uploadDocumentHandler({ name: 'a.md', content: 'c', path: 'p' }, api);
    expect(api.uploadDocument).toHaveBeenCalledWith({ name: 'a.md', content: 'c', path: 'p' });
    expect(r.content[0]).toMatchObject({ type: 'text' });
    expect(r.content[0].text).toContain('http://s/t');
});

test('handler 透传 api 错误（不吞）', async () => {
    const api = { uploadDocument: vi.fn(async () => {
        throw new Error('boom');
    }) };
    await expect(uploadDocumentHandler({ name: 'a', content: 'b' }, api)).rejects.toThrow('boom');
});
