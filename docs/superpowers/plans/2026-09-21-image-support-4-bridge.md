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

- [ ] **Step 1: 失败测试**：

```ts
import { imageTokenLines, extractLocalImageSrcs } from './image-extract';

describe('imageTokenLines / extractLocalImageSrcs（桥编排单源）', () => {
    it('返回 token 级 {src, line}，math/code 内天然排除', () => {
        const md = '![a](shot.png)\nsome text\n$![x](y.png)$\n```\n![c](z.png)\n```';
        const toks = imageTokenLines(md);
        expect(toks).toEqual([{ src: 'shot.png', line: 0 }]);
    });
    it('原始 src 保留（./ 前缀与 query 原样——文件系统按原样读取）', () => {
        expect(extractLocalImageSrcs('![a](./pics/a b.png)')).toEqual(['./pics/a b.png']);
        expect(extractLocalImageSrcs('![a](a.png?x=1)')).toEqual(['a.png?x=1']);
    });
    it('scheme 过滤（http/data/mailto 不进本地列表）', () => {
        expect(extractLocalImageSrcs('![a](https://x.com/a.png)![b](data:image/png;base64,x)')).toEqual([]);
    });
    it('含分隔符的相对路径保留（本地路径语义——与裸名提取器 extractImageNames 的分工）', () => {
        expect(extractLocalImageSrcs('![a](sub/dir/a.png)')).toEqual(['sub/dir/a.png']);
    });
    it('去重保序（改写一处定义替换全部出现）', () => {
        expect(extractLocalImageSrcs('![a](x.png)![b](x.png)')).toEqual(['x.png']);
    });
});
```

- [ ] **Step 2: 确认失败 → Step 3: 实现**（image-extract.ts 追加）：

```ts
export interface ImageTokenLine { src: string; line: number }

/** token 级图片引用（含所在行号）：桥预检收集与改写定位共用（spec §6.1/§6.3）。
 *  math/code 内排除与 extractImageNames 同构（同一 parser 实例）。 */
export function imageTokenLines(src: string): ImageTokenLine[] {
    const out: ImageTokenLine[] = [];
    const walk = (toks: MarkdownIt.Token[]): void => {
        for (const t of toks) {
            if (t.type === 'image' && t.map) out.push({ src: t.attrGet('src') ?? '', line: t.map[0] });
            if (t.children) walk(t.children);
        }
    };
    walk(parser().parse(src, {}));
    return out;
}

/** 桥侧本地图片引用（原始 src，scheme 过滤，去重保序）：文件系统按 src 原样读取，
 *  与 extractImageNames（归一化裸名）分工——那侧匹配服务器池，这侧读本地盘。 */
export function extractLocalImageSrcs(src: string): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const { src: raw } of imageTokenLines(src)) {
        if (!raw || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(raw)) continue;
        if (!seen.has(raw)) { seen.add(raw); out.push(raw); }
    }
    return out;
}
```

- [ ] **Step 4/5: 绿 → Commit** `feat(shared): imageTokenLines/extractLocalImageSrcs——桥编排 token 级单源`

---

### Task 2: api-client 四方法 + 429 语义

**Files:** Modify `packages/shared/src/api-client.ts`；Test `packages/shared/src/api-client.test.ts`（追加；现有 mock fetch 模式照旧）

- [ ] **Step 1: 失败测试**（场景；沿用该文件现有 fetch mock 先例）：

```
initImage：三态透传（exists/relay/direct 的 json 字段直译）；
  401/413/400（message 透传）；429 → ApiError 带 retryAfter=Retry-After 秒数
relayImage：{name} 成功；404 → ApiError(404)；400 invalid → ApiError(400, reason 透传)
confirmImage：{status:'ok',name}；404 {status:'missing'}；400 {status:'invalid',reason}
putImageBytes：fetch PUT 二进制（Body 是 Buffer）；非 2xx → ApiError
超时：图片三方法 + putBytes 用 IMAGE_TIMEOUT_MS=300s（mock 慢响应验证 AbortSignal 传参——以实现内常量断言为准，不强测时间）
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

async function requestJson<T>(url: string, init: RequestInit, timeoutMs: number): Promise<{ status: number; headers: Headers; body: T & { message?: string } }> {
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
        throw new ApiError(res.status, mapMessage(res.status, (body as { message?: string }).message), retryAfter);
    }
    return { status: res.status, headers: res.headers, body: body as T & { message?: string } };
}

// ApiClient 接口追加四方法（createApiClient 实现内均走 requestJson + Bearer 头）：
export interface ApiClient {
    uploadDocument(input: { name: string; content: string; path?: string }): Promise<{ id: string; url: string }>;
    initImage(input: { name: string; contentHash: string; contentMd5: string; sizeBytes: number }): Promise<{ status: 'exists'; name: string } | { status: 'relay'; name: string; imageId: string } | { status: 'direct'; name: string; imageId: string; uploadUrl: string }>;
    relayImage(input: { imageId: string; contentBase64: string }): Promise<{ name: string }>;
    confirmImage(input: { imageId: string }): Promise<{ status: 'ok'; name: string }>;
    putImageBytes(uploadUrl: string, data: Buffer): Promise<void>;
}
```

（`uploadDocument` 既有实现不动；invalid 的 reason 字段：relay/confirm 400 响应体 `{status:'invalid',reason}`——requestJson 只透传 message，reason 在 mapMessage 默认分支透传 message 不够。**修正**：三图片方法的错误解析单独读 `body.reason ?? body.message` 再 mapMessage——实现时在方法内联处理，requestJson 保持通用。）

- [ ] **Step 4/5: 绿（含既有 uploadDocument 测试零回归）→ Commit** `feat(shared): api-client 图片四方法（init/relay/confirm/putBytes）+ 429 retryAfter + 300s 图片超时`

---

### Task 3: image-pipeline 编排（两阶段/六类错误/退避/改写/摘要）

**Files:** Create `packages/shared/src/tools/image-pipeline.ts`；Test `packages/shared/src/tools/image-pipeline.test.ts`

- [ ] **Step 1: 失败测试**（场景清单；mock ApiClient + tmpdir 真文件 + PNG/JPEG/GIF 魔数 Buffer；`vi.useFakeTimers` 测退避 sleep）：

```
阶段一预检（collectImageProblems——导出供测试）：
  - 正常两图（PNG+JPEG 魔数）→ [] 零问题
  - FILE_NOT_FOUND：不存在 src → 问题含 resolvedPath 与 cwd 基准提示（hint 含"相对路径按桥工作目录解析"）
  - IS_DIRECTORY / PERMISSION_DENIED（chmod 000）/ READ_ERROR（读魔数时 mock 抛错——用注入 fs 或跳过：stat 过但 read 前 32B 失败难注入真 fs——实现时 read 魔数包 try/catch 映射 READ_ERROR，测试用 chmod 000 目录下文件覆盖两码）
  - TOO_LARGE：>50MB 硬护栏（Buffer 写不了 50MB——stat mock？改为实现侧 stat.size 与上限比较，测试用稀疏文件 fs.truncate 造大文件 ✓）
  - UNSUPPORTED_FORMAT：<svg> 字节 → detail 含 SVG 不支持文案；未知字节 → 通用文案
  - 多问题一次性全报（两个坏图 → 两条），格式化输出（formatImageProblems）为多行结构含 [i/N]/建议
阶段二上传（orchestrateImages——导出）：
  - exists → 复用注册名（init 只调一次；reused 计数）
  - direct → putImageBytes+confirm ok（uploadUrl 透传）
  - direct → confirm missing → 重 PUT 一次再 confirm → ok
  - relay → base64 body 长度正确（mock 捕获）
  - 429：init 抛 ApiError(429, retryAfter=1) → sleep(1s) 重试成功（fake timers advance）
  - 429 无 retryAfter → 默认 30s；退避 2 次仍 429 → throw 进度摘要文本
  - relay invalid → throw 含 reason 与进度（"已成功 N 张…失败于第 X/Y 张"）
  - 同一图两次引用 → 一次上传两处改写（rewrites=2）
  - 进度摘要：成功返回 {content 改写后 md, summary:"新传 N · 复用 M · 引用改写 K 处"}
改写（rewriteImageRefs——导出）：
  - token 级：code block 内相同 src 文本不被替换（map 行内替换的证据用例）
  - raw→服务器名（exists 分支返回的注册名，非请求名）
```

- [ ] **Step 3: 实现**（image-pipeline.ts 完整骨架——执行者按此展开，行为规格以场景清单为准）：

```ts
import { stat, readFile } from 'node:fs/promises';
import { isAbsolute, join, basename } from 'node:path';
import { createHash } from 'node:crypto';
import { imageTokenLines } from '../image-extract';
import { detectImageMime } from '../image-mime';
import { ApiError, type ApiClient } from '../api-client';

// 桥侧硬护栏（防 50MB+ 读进内存）：服务端 MAX_IMAGE_BYTES（413）是权威上限——桥不知道服务器配置
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

function resolveLocal(src: string): string {
    return isAbsolute(src) ? src : join(process.cwd(), src);
}

/** 阶段一：全部本地图一次性体检（stat→魔数 32B），零字节上传 */
export async function collectImageProblems(md: string): Promise<ImageProblem[]> {
    const problems: ImageProblem[] = [];
    const srcs = [...new Set(imageTokenLines(md).map((t) => t.src).filter((s) => s && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)))];
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
        try { head = Buffer.alloc(32); /* readFile 前 32B：open+read（node:fs/promises open） */ }
        catch (e) { problems.push({ code: 'READ_ERROR', src, resolvedPath, detail: (e as Error).message }); continue; }
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
    const lines = imageTokenLines(md);
    const srcs = [...new Set(lines.map((t) => t.src).filter((s) => s && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)))];
    const rename = new Map<string, string>(); // raw → 服务器注册名
    let uploaded = 0, reused = 0;
    for (let i = 0; i < srcs.length; i++) {
        const src = srcs[i];
        try {
            const buf = await readFile(resolveLocal(src));
            const contentHash = createHash('sha256').update(buf).digest('hex');
            const contentMd5 = createHash('md5').update(buf).digest('hex');
            const init = await with429Retry(() => api.initImage({ name: basename(resolveLocal(src)), contentHash, contentMd5, sizeBytes: buf.length }));
            if (init.status === 'exists') { rename.set(src, init.name); reused++; continue; }
            if (init.status === 'relay') {
                const r = await with429Retry(() => api.relayImage({ imageId: init.imageId, contentBase64: buf.toString('base64') }));
                rename.set(src, r.name);
            } else {
                await with429Retry(() => api.putImageBytes(init.uploadUrl, buf));
                let confirmed = await with429Retry(() => api.confirmImage({ imageId: init.imageId }));
                if (confirmed === null) { /* confirm 404 missing → 重 PUT 一次再 confirm（spec §6.2） */ }
                rename.set(src, confirmed.name);
            }
            uploaded++;
        } catch (e) {
            throw new Error(`图片上传中断：已成功 ${uploaded + reused} 张（重试时相同内容自动跳过），失败于第 ${i + 1}/${srcs.length} 张 "${src}"：${(e as Error).message}`);
        }
    }
    const { content, rewrites } = rewriteImageRefs(md, rename);
    return { content, uploaded, reused, rewrites };
}

/** token 级改写（spec §6.3）：按 image token 的 map 行内替换 src——code block 内同文本不误伤 */
export function rewriteImageRefs(md: string, rename: Map<string, string>): { content: string; rewrites: number } {
    if (rename.size === 0) return { content: md, rewrites: 0 };
    const lineSet = new Map<number, Set<string>>();
    for (const t of imageTokenLines(md)) {
        if (rename.has(t.src)) (lineSet.get(t.line) ?? lineSet.set(t.line, new Set()).get(t.line)!).add(t.src);
    }
    const lines = md.split('\n');
    let rewrites = 0;
    for (const [line, srcs] of lineSet) {
        for (const src of srcs) {
            const before = lines[line];
            lines[line] = lines[line].split(src).join(rename.get(src)!);
            if (lines[line] !== before) rewrites++;
        }
    }
    return { content: lines.join('\n'), rewrites };
}
```

（`confirmed === null` 分支为骨架示意——实现时 confirm 的 404 missing 由 api-client 抛 ApiError(404)，编排 catch 后**重 PUT+confirm 各一次**再失败才 throw；`readFile 前 32B` 用 `open()`+`read()` 实现而非全量读——预检省内存的意义所在；`lineSet` 的 get/set 链写成清晰 if 形式。这些是展开指令非占位符——行为规格在场景清单。）

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
    '支持 png/jpeg/gif/webp（SVG 不支持），单图建议 ≤10MB；预检发现的问题会一次性全部列出。',
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

1. **Spec 覆盖**：§6.1 两阶段+六类错误+cwd 诊断 ✓ / §6.2 双通道+missing 重 PUT+429 退避+300s+进度摘要 ✓ / §6.3 token 级改写（code block 防误伤测试）+注册名非请求名 ✓ / 描述文案（多图耗时+格式+预检一次性）✓。**不在本批**：桥 README/USER_GUIDE 更新（Phase 5 文档批）；`IMAGE_PROXY_ALL` 等 web 侧无涉。
2. **无占位符**：Task 3 骨架的两处展开指令（confirm missing 重试链/32B 读实现）行为规格在场景清单明确；lineSet 展开为清晰 if。
3. **类型一致性**：ApiClient 四方法签名与 Phase 2 路由响应形状逐字段对齐（init 三态/relay {name}/confirm {status:'ok',name}/invalid reason）；ApiError 第三参向后兼容。
4. **风险点**：api-client 既有 uploadDocument 测试零回归（requestJson 抽取不动原方法）；50MB 稀疏文件测试（truncate）在 tmpdir；fake timers 与真 fs 混用（退避用例只 mock api 不碰 fs）。
