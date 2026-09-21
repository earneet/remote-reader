import { stat, readFile, open } from 'node:fs/promises';
import { isAbsolute, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { imageTokenLines, extractLocalImageSrcs, decodeLocalSrc, MAX_IMAGE_REFS } from '../image-extract';
import { detectImageMime } from '../image-mime';
import { ApiError, type ApiClient } from '../api-client';

// 桥侧硬护栏（防超大文件读进内存）：与服务器 MAX_IMAGE_BYTES 是两道独立校验（服务器 413 仍是权威）
const BRIDGE_SIZE_GUARD = 50 * 1024 * 1024;
const RETRY_429_DEFAULT_S = 30;
const RETRY_429_MAX = 2;

export type ImageProblemCode = 'FILE_NOT_FOUND' | 'PERMISSION_DENIED' | 'IS_DIRECTORY' | 'TOO_LARGE' | 'UNSUPPORTED_FORMAT' | 'READ_ERROR';
export interface ImageProblem { code: ImageProblemCode; src: string; resolvedPath?: string; detail?: string; hint?: string }

export class ImageValidationError extends Error {
    constructor(public problems: ImageProblem[]) { super(formatImageProblems(problems)); this.name = 'ImageValidationError'; }
}

/** 多行机器可解析结构（spec §6.1 步骤 4）：upload_document 失败：图片预检发现 N 个问题… [i/N] CODE: "src" + 路径/详情/建议行 */
export function formatImageProblems(problems: ImageProblem[]): string {
    const lines = [`upload_document 失败：图片预检发现 ${problems.length} 个问题：`];
    problems.forEach((p, i) => {
        lines.push(`[${i + 1}/${problems.length}] ${p.code}: "${p.src}"`);
        if (p.resolvedPath) lines.push(`  路径: ${p.resolvedPath}`);
        if (p.detail) lines.push(`  详情: ${p.detail}`);
        if (p.hint) lines.push(`  建议: ${p.hint}`);
    });
    return lines.join('\n');
}

/** 本地路径解析（P1-1）：src 是 markdown-it normalizeLink 的编码形态——先 decode 再 join cwd */
function resolveLocal(src: string): string {
    const decoded = decodeLocalSrc(src);
    return isAbsolute(decoded) ? decoded : join(process.cwd(), decoded);
}

/** 阶段一：全部本地图一次性体检（stat→魔数 32B），零字节上传 */
export async function collectImageProblems(md: string): Promise<ImageProblem[]> {
    const problems: ImageProblem[] = [];
    const srcs = extractLocalImageSrcs(md); // P2-6：单源复用
    // 数量上限预检（先于文件 IO，与服务器 413 同源常量）：免得 501 张都 stat 完才在服务端被拒
    if (srcs.length > MAX_IMAGE_REFS) {
        throw new Error(`文档图片引用超过上限 ${MAX_IMAGE_REFS}，请拆分文档`);
    }
    for (const src of srcs) {
        const resolvedPath = resolveLocal(src);
        let st;
        try { st = await stat(resolvedPath); }
        catch (e) {
            const code = (e as NodeJS.ErrnoException).code;
            problems.push(code === 'EACCES' || code === 'EPERM'
                ? { code: 'PERMISSION_DENIED', src, resolvedPath, hint: '桥进程无权读取该文件，检查文件权限' }
                : { code: 'FILE_NOT_FOUND', src, resolvedPath, hint: '确认文件存在；相对路径按桥工作目录（cwd）解析，或改用绝对路径' });
            continue;
        }
        if (st.isDirectory()) { problems.push({ code: 'IS_DIRECTORY', src, resolvedPath, hint: '引用指向目录，请指到具体图片文件' }); continue; }
        if (st.size > BRIDGE_SIZE_GUARD) { problems.push({ code: 'TOO_LARGE', src, resolvedPath, detail: `实际 ${st.size}B 超过桥护栏 ${BRIDGE_SIZE_GUARD}B`, hint: '压缩或裁剪后重试' }); continue; }
        let head: Buffer;
        try {
            // 只读前 32B（预检省内存的意义）：open + read，不整读
            const fh = await open(resolvedPath, 'r');
            try {
                head = Buffer.alloc(32);
                await fh.read(head, 0, 32, 0);
            } finally {
                await fh.close();
            }
        } catch (e) { problems.push({ code: 'READ_ERROR', src, resolvedPath, detail: (e as Error).message }); continue; }
        const mime = detectImageMime(head);
        if (mime === null) {
            const isSvg = head.subarray(0, 5).toString('latin1').startsWith('<');
            problems.push({ code: 'UNSUPPORTED_FORMAT', src, resolvedPath,
                detail: isSvg ? 'SVG 不被支持（可携带脚本，安全考虑；支持 png/jpeg/gif/webp）' : '无法识别的图片格式（支持 png/jpeg/gif/webp）',
                hint: '转换为 png/jpeg 后重试' });
        }
    }
    return problems;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 429 退避重试壳（spec #14/P2-3）：Retry-After 优先，默认 30s，至多 2 次 */
async function with429Retry<T>(fn: () => Promise<T>): Promise<T> {
    for (let i = 0; ; i++) {
        try { return await fn(); }
        catch (e) {
            if (e instanceof ApiError && e.status === 429 && i < RETRY_429_MAX) {
                await sleep((e.retryAfter ?? RETRY_429_DEFAULT_S) * 1000);
                continue;
            }
            throw e;
        }
    }
}

export interface OrchestrateResult { content: string; uploaded: number; reused: number; rewrites: number }

/** 阶段二：逐图上传（exists/direct+confirm/relay）→ 返回改写后的 md 与计数（spec §6.2/§6.3） */
export async function orchestrateImages(md: string, api: ApiClient): Promise<OrchestrateResult> {
    const srcs = extractLocalImageSrcs(md); // P2-6：单源复用
    const rename = new Map<string, string>(); // raw（编码形态）→ 服务器注册名
    let uploaded = 0, reused = 0;
    for (let i = 0; i < srcs.length; i++) {
        const src = srcs[i];
        try {
            const buf = await readFile(resolveLocal(src));
            const contentHash = createHash('sha256').update(buf).digest('hex');
            const contentMd5 = createHash('md5').update(buf).digest('hex');
            const init = await with429Retry(() => api.initImage({ name: basename(decodeLocalSrc(src)), contentHash, contentMd5, sizeBytes: buf.length }));
            if (init.status === 'exists') { rename.set(src, init.name); reused++; continue; }
            if (init.status === 'relay') {
                const r = await with429Retry(() => api.relayImage({ imageId: init.imageId, contentBase64: buf.toString('base64') }));
                rename.set(src, r.name);
            } else {
                await with429Retry(() => api.putImageBytes(init.uploadUrl, buf));
                let name: string | undefined;
                try {
                    name = (await with429Retry(() => api.confirmImage({ imageId: init.imageId }))).name;
                } catch (e) {
                    // P2-1：confirm-404（missing）→ 重 PUT+confirm 各一次（spec §6.2）——catch 收窄在
                    // confirm 周围，不吞 relay 404 或其他错误
                    if (e instanceof ApiError && e.status === 404) {
                        await with429Retry(() => api.putImageBytes(init.uploadUrl, buf));
                        name = (await with429Retry(() => api.confirmImage({ imageId: init.imageId }))).name;
                    } else throw e;
                }
                rename.set(src, name);
            }
            uploaded++;
        } catch (e) {
            throw new Error(`图片上传中断：已成功 ${uploaded + reused} 张（重试时相同内容自动跳过），失败于第 ${i + 1}/${srcs.length} 张 "${decodeLocalSrc(src)}"：${(e as Error).message}`);
        }
    }
    const { content, rewrites } = rewriteImageRefs(md, rename);
    return { content, uploaded, reused, rewrites };
}

/** token 级改写（spec §6.3）：按 image token 定位行，行内替换 src →注册名。
 *  双形态：md 原文可能是 normalizeLink 前的原文（中文/空格）或编码形态——两种变体都映射到注册名
 *  （Task 1 遗留边界的改写侧另一半，与 imageTokenLines.lineOf 的双形态匹配配套）。
 *  P2-2：每行单趟 alternation 正则（长 src 优先 + escapeRegExp）+ 回调查表——
 *  顺序 split/join 会互蚀（mylogo.png 含 logo.png 子串时后写污染已改写文本）。 */
export function rewriteImageRefs(md: string, rename: Map<string, string>): { content: string; rewrites: number } {
    if (rename.size === 0) return { content: md, rewrites: 0 };
    const match = new Map<string, string>();
    for (const [raw, to] of rename) {
        match.set(raw, to);
        const decoded = decodeLocalSrc(raw);
        if (decoded !== raw) match.set(decoded, to);
    }
    const lines = md.split('\n');
    const lineSrcs = new Map<number, Set<string>>();
    for (const t of imageTokenLines(md)) {
        if (!rename.has(t.src)) continue;
        const set = lineSrcs.get(t.line) ?? new Set<string>();
        set.add(t.src);
        lineSrcs.set(t.line, set);
    }
    const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let rewrites = 0;
    for (const [line, srcs] of lineSrcs) {
        // 行定位失败（转义/entity 写法使原文行不含 src 任何形态，终审 P3）→ 跳过而非 crash：
        // 残留本地路径在渲染端自愈（两端 markdown-it 均做 entity/转义 decode → 裸名命中已上传图）
        if (line < 0 || line >= lines.length) continue;
        const variants = [...srcs].flatMap((s) => (decodeLocalSrc(s) === s ? [s] : [s, decodeLocalSrc(s)]));
        const ordered = variants.sort((a, b) => b.length - a.length); // 长 src 优先（alternation 左侧优先匹配）
        const re = new RegExp(ordered.map(escapeRegExp).join('|'), 'g');
        let hit = false;
        lines[line] = lines[line].replace(re, (m) => {
            hit = true;
            return match.get(m) ?? m;
        });
        if (hit) rewrites++;
    }
    return { content: lines.join('\n'), rewrites };
}
