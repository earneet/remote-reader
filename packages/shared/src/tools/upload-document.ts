import { z } from 'zod';
import { collectImageProblems, orchestrateImages, ImageValidationError } from './image-pipeline';
import type { ApiClient } from '../api-client';

export const uploadDocumentSchema = z.object({
    name: z.string().describe('文档文件名，如 "weekly.md"。禁含 .. / 绝对路径 / \\ : * ? " < > | / null byte'),
    content: z.string().describe('Markdown 正文（UTF-8）'),
    path: z.string().optional().describe('可选目录前缀，POSIX 风格，如 "reports/2026-07"')
});

export const uploadDocumentDescription = [
    '幂等上传一份 Markdown 文档到 Remote Reader，返回一个免登录、点开即见渲染结果的查看链接。',
    '同 path+name+内容重复上传不产生重复，链接长期稳定；内容变化则原地覆盖、链接不变。',
    'content 内的本地图片引用（![alt](本地路径)，相对路径按桥工作目录解析）会被自动上传并改写引用——',
    '支持 png/jpeg/gif/webp（SVG 不支持），单图建议 ≤10MB，单文档硬上限 500 张图（服务端强制，超过 413）；',
    '预检发现的问题（文件不存在/格式不支持/超大等）会一次性全部列出。',
    'content 上限默认 5MB（MAX_UPLOAD_BYTES 可调）；多图文档上传耗时较长。',
    '上传成功后，请把返回的 url 通过当前对话/IM 发给用户，并简述文档内容。'
].join(' ');

export interface UploadDocumentArgs {
    name: string;
    content: string;
    path?: string;
}

export async function uploadDocumentHandler(
    args: UploadDocumentArgs,
    api: ApiClient
): Promise<{ content: { type: 'text'; text: string }[] }> {
    const problems = await collectImageProblems(args.content);
    if (problems.length > 0) throw new ImageValidationError(problems); // 桥 catch → isError 多行清单（spec #14）
    const { content, uploaded, reused, rewrites } = await orchestrateImages(args.content, api);
    const { id, url } = await api.uploadDocument({ ...args, content });
    const imgSummary = uploaded + reused > 0 ? `。图片：新传 ${uploaded} · 复用 ${reused} · 引用改写 ${rewrites} 处` : '';
    return { content: [{ type: 'text', text: `已上传（id=${id}）。查看链接：${url}${imgSummary}` }] };
}
