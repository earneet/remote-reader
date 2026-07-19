import { z } from 'zod';

export const uploadDocumentSchema = z.object({
    name: z.string().describe('文档文件名，如 "weekly.md"。禁含 .. / 绝对路径 / \\ : * ? " < > | / null byte'),
    content: z.string().describe('Markdown 正文（UTF-8）'),
    path: z.string().optional().describe('可选目录前缀，POSIX 风格，如 "reports/2026-07"')
});

export const uploadDocumentDescription = [
    '幂等上传一份 Markdown 文档到 Remote Reader，返回一个免登录、点开即见渲染结果的查看链接。',
    '同 path+name+内容重复上传不产生重复，链接长期稳定；内容变化则原地覆盖、链接不变。',
    '上传成功后，请把返回的 url 通过当前对话/IM 发给用户，并简述文档内容。'
].join(' ');

export interface UploadDocumentArgs {
    name: string;
    content: string;
    path?: string;
}

export async function uploadDocumentHandler(
    args: UploadDocumentArgs,
    api: { uploadDocument(input: UploadDocumentArgs): Promise<{ id: string; url: string }> }
): Promise<{ content: { type: 'text'; text: string }[] }> {
    const { id, url } = await api.uploadDocument(args);
    return { content: [{ type: 'text', text: `已上传（id=${id}）。查看链接：${url}` }] };
}
