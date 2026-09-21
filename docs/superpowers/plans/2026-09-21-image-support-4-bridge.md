# 图片支持 · Phase 4：MCP 桥编排（两阶段 · 六类错误 · 双通道 · md 改写）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `upload_document` 工具内建图片编排——桥端解析 md 本地图片引用，两阶段（预检零字节上传→逐图上传双通道）后 token 级改写引用为服务器注册名，Agent 侧零新增概念。

**Architecture:** 编排逻辑全部在 `packages/shared`（工具层与 transport 解耦的既定原则）：`image-extract.ts` 增 `imageTokenLines`（预检收集与改写定位共用单源）；新 `image-pipeline.ts`（预检/上传/退避/改写/摘要）；`api-client.ts` 增四方法（init/relay/confirm/putBytes + 429 retryAfter 解析 + 图片 300s 超时）。桥 `index.ts` **零改动**（handler 第二参数类型扩为完整 ApiClient，桥传入的实例自动获得新方法）。

**Tech Stack:** node:fs/promises + node:crypto（shared 工具层，桥/web 均为 node 运行时）；markdown-it（已在 shared 依赖）。

**Spec:** §6（6.1 两阶段/6.2 上传/6.3 改写）、§5（API 响应形状）、#14（fail-fast 两阶段）。**批次**：第 4/5 批。

## 运行纪律（同前三批）

worktree `bun install` + `cd apps/web && bunx svelte-kit sync`；TDD；`json(body,{status})`；测试放 `packages/shared/src/**`（vitest include 覆盖）。

---

### Task 1: shared imageTokenLines（预检/改写共用的 token 级单源）

**Files:** Modify `packages/shared/src/image-extract.ts`；Test `packages/shared/src/image-extract.test.ts`（追加）

**⚠️ markdown-it 行为前提（Oracle 实机探针验证）**：`image` 是 inline 层 token，`.map` 恒为 null；行信息在**父 `inline` token** 的块级 map（`[startLine, endLine)` 行范围）。且表格内 inline 连父 map 都为 null。因此实现必须走**父链携带**方案：

- [ ] **Step 1: 失败测试**：

```ts
import { imageTokenLines, extractLocalImageSrcs } from './image-extract';

describe('imageTokenLines / extractLocalImageSrcs（桥编排单源）', () => {
    it('返回 token 级 {src, line}——行取父 inline map 范围内含该 src 的行', () => {
        const md = '![a](shot.png)\nsome text\n$![x](y.png)$\n```\n![c](z.png)\n```';
        const toks = imageTokenLines(md);
        expect(toks).toEqual([{ src: 'shot.png', line: 0 }]);
    });
    it('多行段落：图片在非首行 → line 是图片实际所在行（非块首行）', () => {
        const toks = imageTokenLines('l0\n![m](m.png)\nl2');
        expect(toks).toEqual([{ src: 'm.png', line: 1 }]);
    });
    it('原始 src 保留编码形态（normalizeLink 产物——文件系统读取时 decode，改写时用原样）', () => {
        // markdown-it normalizeLink 对空格/CJK 百分号编码；尖括号语法才允许空格
        expect(extractLocalImageSrcs('![a](<./pics/a b.png>)')).toEqual(['./pics/a%20b.png']);
        expect(extractLocalImageSrcs('![截图](截图.png)')).toEqual(['%E6%88%AA%E5%9B%BE.png']);
        expect(extractLocalImageSrcs('![a](a.png?x=1)')).toEqual([expect.stringContaining('a.png')]); // query 形态以实测为准
    });
    it('scheme 过滤（http/data 不进本地列表）+ Windows 盘符例外', () => {
        expect(extractLocalImageSrcs('![a](https://x.com/a.png)![b](data:image/png;base64,x)')).toEqual([]);
        // C:\ / C:/ 是盘符路径不是 scheme（P2-5：否则 Windows 绝对路径静默跳过）
        expect(extractLocalImageSrcs('![a](C:\\Users\\me\\shot.png)')).toEqual(['C:\\Users\\me\\shot.png']);
    });
    it('含分隔符的相对路径保留（本地路径语义——与裸名提取器 extractImageNames 的分工）', () => {
        expect(extractLocalImageSrcs('![a](sub/dir/a.png)')).toEqual(['sub/dir/a.png']);
    });
    it('去重保序', () => {
        expect(extractLocalImageSrcs('![a](x.png)![b](x.png)')).toEqual(['x.png']);
    });
    it('表格内图片：父 inline 无 map → 降级返回该 src 的全部出现行（改写走全文逐行）', () => {
        const md = '| a | b |\n|---|---|\n| ![x](t.png) | y |';
        const toks = imageTokenLines(md);
        expect(toks.length).toBe(1);
        expect(toks[0].src).toBe('t.png');
        // line 为图片实际行（实现：表格内 inline.map=null → 扫描含 src 的行取首个；改写安全由 split/join 天然保证）
        expect(toks[0].line).toBe(2);
    });
});
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**（image-extract.ts 追加）：

```ts
export interface ImageTokenLine { src: string; line: number }

/** token 级图片引用（含所在行号）：桥预检收集与改写定位共用（spec §6.1/§6.3）。
 *  ⚠️ markdown-it 中 image（inline 层）token 的 .map 恒 null（Oracle 探针实证）——行信息在
 *  父 inline token 的块级 map [start, end)。父 map 亦为 null（表格）时扫描含 src 的行兜底。 */
export function imageTokenLines(src: string): ImageTokenLine[] {
    const out: ImageTokenLine[] = [];
    const lines = src.split('\n');
    const lineOf = (raw: string, range: [number, number] | null): number => {
        if (range) {
            for (let i = range[0]; i < range[1] && i < lines.length; i++) {
                if (lines[i].includes(raw)) return i;
            }
        }
        return lines.findIndex((l) => l.includes(raw)); // null 或范围未命中：全文找（首现行）
    };
    const walk = (toks: MarkdownIt.Token[], parentMap: [number, number] | null): void => {
        for (const t of toks) {
            if (t.type === 'inline' && t.map) parentMap = [t.map[0], t.map[1]];
            if (t.type === 'image') {
                const raw = t.attrGet('src') ?? '';
                if (raw) out.push({ src: raw, line: lineOf(raw, parentMap) });
            }
            if (t.children) walk(t.children, parentMap);
        }
    };
    walk(parser().parse(src, {}), null);
    return out;
}

/** 桥侧本地图片引用（原始 src——markdown-it normalizeLink 后的编码形态，去重保序）：
 *  文件系统读取时由调用方 decode（P1-1），改写时用编码原样（spec §6.3 "替换 src 编码形态"）。
 *  scheme 过滤含 Windows 盘符例外（P2-5）。 */
const WINDOWS_DRIVE = /^[a-zA-Z]:[\\/]/;

export function extractLocalImageSrcs(src: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const { src: raw } of imageTokenLines(src)) {
        if (!raw) continue;
        if (WINDOWS_DRIVE.test(raw)) { if (!seen.has(raw)) { seen.add(raw); out.push(raw); } continue; }
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) continue;
        if (!seen.has(raw)) { seen.add(raw); out.push(raw); }
    }
    return out;
}

/** 桥侧读盘用：编码形态 src → 本地路径（decode + cwd join，P1-1） */
export function decodeLocalSrc(raw: string): string {
    let s = raw;
    try { s = decodeURIComponent(raw); } catch { /* 非法编码按原样 */ }
    return s;
}
```

- [ ] **Step 4/5: 绿 → Commit** `feat(shared): imageTokenLines/extractLocalImageSrcs/decodeLocalSrc——桥编排 token 级单源（父链行定位 P0-1/盘符例外 P2-5/decode 助手 P1-1）`

---

### Task 2: api-client 四方法 + 429 语义

**Files:** Modify `packages/shared/src/api-client.ts`；Test `packages/shared/src/api-client.test.ts`（追加；现有 mock fetch 模式照旧）

**⚠️ wire 键名（P1-3）：请求体一律 snake_case（与 Phase 2 路由对齐）**——init 发 `{name, content_hash, content_md5, size_bytes}`、relay 发 `{image_id, content_base64}`、confirm 发 `{image_id}`；响应是 camelCase（`json(result)` 原样）。Step 1 测试必须**捕获 body 断言键名**（mock 拦不住键名错误，此处是唯一防线）。

**⚠️ putImageBytes 独立实现（P1-2）：不带 Authorization 头**——presigned PUT 是第三方云 URL，S3 SigV4 query 签名与 header 认证互斥（带即 400），且发送 Bearer 会把服务器 API token 外泄给云厂商。已核实 `blobstore-s3.presign('put')` 未签 Content-Type → PUT 不发该头。

- [ ] **Step 1: 失败测试**（场景；沿用该文件现有 fetch mock 先例）：

```
initImage：三态透传（exists/relay/direct 的 json 字段直译）+ 请求 body 键名断言（snake_case）；
  401/413/400（message 透传）；429 → ApiError 带 retryAfter=Retry-After 秒数
relayImage：{name} 成功 + body 键名断言；404 → ApiError(404)；400 invalid → ApiError(400, reason 透传而非 message)
confirmImage：{status:'ok',name}；404 {status:'missing'}；400 {status:'invalid',reason}
putImageBytes：fetch PUT 二进制（Body 是 Buffer）；请求头断言【无 Authorization】；非 2xx → ApiError
超时：图片三方法 + putBytes 用 IMAGE_TIMEOUT_MS=300s（以实现内常量断言为准）
```

- [ ] **Step 3: 实现**（api-client.ts 追加；核心形状）：

```ts
// 图片上传慢链路（10MB base64 ≈13MB / 直传字节）需远大于文档 60s——spec §6.2
const IMAGE_TIMEOUT_MS = 300_000;

export class ApiError extends Error {
    public retryAfter?: number;
    constructor(status: number, message: string, retryAfter?: number) {
        super(message); this.name = 'ApiError'; this.status = status; this.retryAfter = retryAfter;
    }
}
// （status 已是实例属性——构造器升级为兼容第三参；既有两参调用零改动）

// P2-1：messageFrom 提取器——invalid 响应是 {status:'invalid',reason} 而非 error() 的 {message}，
// 由各图片方法注入（requestJson 保持通用，uploadDocument 不传走默认 message）
async function requestJson<T>(
    url: string, init: RequestInit, timeoutMs: number,
    messageFrom?: (body: Record<string, unknown>) => string | undefined
): Promise<{ status: number; headers: Headers; body: T }> {
    let res: Response;
    try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
        const n = (e as Error)?.name;
        if (n === 'TimeoutError' || n === 'AbortError') {
            throw new ApiError(0, `请求超时（${Math.round(timeoutMs / 1000)}s），请检查网络后重试`);
        }
        throw new ApiError(0, `无法连接服务器：${(e as Error).message}`);
    }
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    if (!res.ok) {
        const ra = res.headers.get('retry-after');
        const retryAfter = ra !== null && /^\d+$/.test(ra) ? Number(ra) : undefined;
        const msg = messageFrom ? messageFrom(body) : (body as { message?: string }).message;
        throw new ApiError(res.status, mapMessage(res.status, msg), retryAfter);
    }
    return { status: res.status, headers: res.headers, body: body as T };
}

// ApiClient 接口追加四方法（实现均走 requestJson + Bearer；键名 snake_case）：
export interface ApiClient {
    uploadDocument(input: { name: string; content: string; path?: string }): Promise<{ id: string; url: string }>;
    initImage(input: { name: string; contentHash: string; contentMd5: string; sizeBytes: number }): Promise<{ status: 'exists'; name: string } | { status: 'relay'; name: string; imageId: string } | { status: 'direct'; name: string; imageId: string; uploadUrl: string }>;
    relayImage(input: { imageId: string; contentBase64: string }): Promise<{ name: string }>;
    confirmImage(input: { imageId: string }): Promise<{ status: 'ok'; name: string }>;
    putImageBytes(uploadUrl: string, data: Buffer): Promise<void>;
}
// putImageBytes 实现要点（P1-2）：fetch(uploadUrl, { method:'PUT', body: data, signal })——
// 不带 Authorization、不带 Content-Type（presign 未签它）；非 2xx → ApiError(状态, `图片直传失败：HTTP x`)
```

- [ ] **Step 4/5: 绿（含既有 uploadDocument 测试零回归 + 键名/无 Authorization 头断言）→ Commit** `feat(shared): api-client 图片四方法（snake_case wire/putBytes 无凭证头/429 retryAfter/300s）`

---

### Task 3: image-pipeline 编排（两阶段/六类错误/退避/改写/摘要）

**Files:** Create `packages/shared/src/tools/image-pipeline.ts`；Test `packages/shared/src/tools/image-pipeline.test.ts`

- [ ] **Step 1: 失败测试**（场景清单；mock ApiClient + tmpdir 真文件 + PNG/JPEG/GIF 魔数 Buffer；`vi.useFakeTimers` 测退避 sleep；**root 环境 skipIf**（P2-3）：`const isRoot = process.getuid?.() === 0; describe.skipIf(isRoot)('权限类用例', ...)` 包住 PERMISSION_DENIED/READ_ERROR 两用例）：

```
阶段一预检（collectImageProblems——导出供测试）：
  - 正常两图（PNG+JPEG 魔数）→ [] 零问题
  - 中文/空格文件名（P1-1 回归）：tmpdir 建 "截图 1.png" → md `![x](<截图 1.png>)`（或中文无空格直写）→ 预检通过（decode 后命中磁盘文件）
  - FILE_NOT_FOUND：不存在 src → 问题含 resolvedPath（decode 后形态）与 cwd 基准提示
  - IS_DIRECTORY / PERMISSION_DENIED+READ_ERROR（skipIf root，chmod 000）
  - TOO_LARGE：稀疏文件 fs.truncate 造 60MB（stat 拦截不读内容）
  - UNSUPPORTED_FORMAT：<svg> 字节 → detail 含 SVG 文案；未知字节 → 通用文案
  - 多问题一次性全报（两个坏图 → 两条），格式化输出（formatImageProblems）为多行结构含 [i/N]/建议
阶段二上传（orchestrateImages——导出）：
  - exists → 复用注册名（init 只调一次；reused 计数）
  - direct → putImageBytes+confirm ok（uploadUrl 透传）
  - direct → confirm 首次 404 → 重 PUT+confirm → ok（P2-1 catch 收窄的行为锁定）
  - relay → base64 body 长度正确（mock 捕获）
  - 429：init 抛 ApiError(429, retryAfter=1) → sleep(1s) 重试成功（fake timers advance）
  - 429 无 retryAfter → 默认 30s；退避 2 次仍 429 → throw 进度摘要文本
  - relay invalid → throw 含 reason 与进度（"已成功 N 张…失败于第 X/Y 张"）
  - 同一图两次引用（**不同行**，P3 计数语义）→ 一次上传两处改写（rewrites=2）
  - 进度摘要：成功返回 {content 改写后 md, summary 计数}
改写（rewriteImageRefs——导出）：
  - code block 内相同 src 文本不被替换（token 行定位的证据用例）
  - raw（编码形态）→ 服务器注册名（exists 分支返回的注册名，非请求名）
  - **P2-2 子串互蚀回归**：同行 `![a](mylogo.png) ![b](logo.png)`，mylogo 注册名不变、logo 注册名
    为 `logo-2.png`（mock 设定）→ 改写后 mylogo.png 完整无损（不被 logo 替换污染）
  - **P0-1 行定位回归**：多行段落图片在第二行 → 该行被正确改写；表格内图片 → 行被正确改写
```

- [ ] **Step 3: 实现**（image-pipeline.ts 完整骨架——执行者按此展开，行为规格以场景清单为准）：

```ts
import { stat, readFile, open } from 'node:fs/promises';
import { isAbsolute, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { imageTokenLines, extractLocalImageSrcs, decodeLocalSrc } from '../image-extract';
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

export function formatImageProblems(problems: ImageProblem[]): string {
    // 多行机器可解析结构（spec §6.1 步骤 4 样例）：upload_document 失败：图片预检发现 N 个问题…
    // [i/N] CODE: "src"（+ detail/hint 行）
}

/** 本地路径解析（P1-1）：src 是 markdown-it normalizeLink 的编码形态——先 decode 再 join cwd */
function resolveLocal(src: string): string {
    const decoded = decodeLocalSrc(src);
    return isAbsolute(decoded) ? decoded : join(process.cwd(), decoded);
}

/** 阶段一：全部本地图一次性体检（stat→魔数 32B），零字节上传 */
export async function collectImageProblems(md: string): Promise<ImageProblem[]> {
    const problems: ImageProblem[] = [];
    for (const src of extractLocalImageSrcs(md)) { // P2-6：单源复用
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

/** token 级改写（spec §6.3）：按 image token 定位行，行内替换 src 编码形态→注册名。
 *  P2-2：每行单趟 alternation 正则（长 src 优先 + escapeRegExp）+ 回调查 rename——
 *  顺序 split/join 会互蚀（mylogo.png 含 logo.png 子串时后写污染已改写文本）。 */
export function rewriteImageRefs(md: string, rename: Map<string, string>): { content: string; rewrites: number } {
    if (rename.size === 0) return { content: md, rewrites: 0 };
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
        const ordered = [...srcs].sort((a, b) => b.length - a.length); // 长 src 优先（alternation 左侧优先匹配）
        const re = new RegExp(ordered.map(escapeRegExp).join('|'), 'g');
        let hit = false;
        lines[line] = lines[line].replace(re, (matched) => {
            hit = true;
            return rename.get(matched) ?? matched;
        });
        if (hit) rewrites++;
    }
    return { content: lines.join('\n'), rewrites };
}
```

（代码为终态实现——confirm-404 重 PUT 的 catch 收窄与 32B open+read 均已按 P2-1 落实在上方代码内；`readFile` 在阶段二全量读取用于 hash，与预检的 32B 探测分工明确）

- [ ] **Step 4/5: 绿 → Commit** `feat(shared): image-pipeline 两阶段编排——六类错误/429 退避/双通道/token 级改写（TDD）`

---

### Task 4: handler 集成 + 工具描述更新

**Files:** Modify `packages/shared/src/tools/upload-document.ts`、`packages/shared/src/tools/upload-document.test.ts`

- [ ] **Step 1: 失败测试**（既有 test 模式追加）：

```
- 无图 md：行为与现状逐字一致（不调图片 API——mock 计数=0）
- 带图 md（tmpdir 真 PNG）：全流程 → 文本含"已上传（id=…）。查看链接：…" + "图片：新传 1 · 复用 0 · 引用改写 1 处"
- 预检失败：ImageValidationError → 桥 catch 转 isError（handler 直接 throw——桥 index 的 catch 包装先例）——
  测试断言 handler throw 的 message 是多行问题清单
- 改写后 content 传给 uploadDocument（mock 捕获参数断言引用已是注册名）
```

- [ ] **Step 3: 实现**（handler 改造）：

```ts
import { collectImageProblems, orchestrateImages, ImageValidationError } from './image-pipeline';
import type { ApiClient } from '../api-client';

export const uploadDocumentDescription = [
    '幂等上传一份 Markdown 文档到 Remote Reader，返回一个免登录、点开即见渲染结果的查看链接。',
    '同 path+name+内容重复上传不产生重复，链接长期稳定；内容变化则原地覆盖、链接不变。',
    'content 内的本地图片引用（![alt](本地路径)，相对路径按桥工作目录解析）会被自动上传并改写引用——',
    '支持 png/jpeg/gif/webp（SVG 不支持），单图建议 ≤10MB，单文档建议 ≤50 张图（服务端限流约束）；',
    '预检发现的问题（文件不存在/格式不支持/超大等）会一次性全部列出。',
    'content 上限默认 5MB（MAX_UPLOAD_BYTES 可调）；多图文档上传耗时较长。',
    '上传成功后，请把返回的 url 通过当前对话/IM 发给用户，并简述文档内容。'
].join(' ');

export async function uploadDocumentHandler(args: UploadDocumentArgs, api: ApiClient): Promise<{ content: { type: 'text'; text: string }[] }> {
    const problems = await collectImageProblems(args.content);
    if (problems.length > 0) throw new ImageValidationError(problems); // 桥 catch → isError 多行清单（spec #14）
    const { content, uploaded, reused, rewrites } = await orchestrateImages(args.content, api);
    const { id, url } = await api.uploadDocument({ ...args, content });
    const imgSummary = uploaded + reused > 0 ? `。图片：新传 ${uploaded} · 复用 ${reused} · 引用改写 ${rewrites} 处` : '';
    return { content: [{ type: 'text', text: `已上传（id=${id}）。查看链接：${url}${imgSummary}` }] };
}
```

（桥 index.ts 零改动验证：`bun --filter remote-reader-bridge check`——handler 第二参从结构类型变 ApiClient 接口，桥传入的 createApiClient 实例天然满足 ✓）

- [ ] **Step 4/5: 绿 + 既有 handler 测试回归 → Commit** `feat(shared): upload_document 集成图片编排——零概念扩展 + 工具描述更新`

---

### Task 5: 收尾

- [ ] 全量测试（预期 644 + 新 ~30）+ web svelte-check + **bridge tsc**（桥类型对 shared 新代码的编译验证）+ 桥 smoke 可选（真服务器冒烟留 Phase 5 e2e）
- [ ] 最终 Commit（如有收尾）

## Self-Review 记录

1. **Spec 覆盖**：§6.1 两阶段+六类错误+cwd 诊断 ✓ / §6.2 双通道+missing 重 PUT（catch 收窄 P2-1）+429 退避+300s+进度摘要+**≤50 图建议**（P2-4）✓ / §6.3 token 级改写（编码形态替换/单趟正则防互蚀 P2-2）+注册名非请求名 ✓。
2. **Oracle 审查修复全录**：P0-1 父链行定位（inline.map 范围内含 src 行 + 表格 null 兜底全文行）+ 三条行定位回归用例 / P1-1 decodeLocalSrc（读盘 decode、改写用编码原样）+ 中文/空格回归用例 + 测试语法修正（尖括号）/ P1-2 putImageBytes 无 Authorization/Content-Type + 头断言 / P1-3 wire 键名 snake_case 标注 + body 键名断言 / P2-1 requestJson messageFrom 提取器 + confirm-404 catch 收窄 / P2-2 单趟 alternation 正则 + 子串互蚀回归 / P2-3 root skipIf / P2-5 盘符例外 / P2-6 两处单源复用。
3. **类型一致性**：ApiClient 四方法 camelCase 接口 ↔ snake_case wire（显式映射）；ApiError 第三参向后兼容；handler 收窄为 ApiClient（既有测试 mock 运行时不炸，类型层 as 或补全——P3 备案）。
4. **风险点**：50MB 护栏是独立于服务端的第二道校验（措辞已改）；rewrites 行级计数语义（同行多引用=1，测试用不同行）；测试基数以 `bun run test` 实测为准。
