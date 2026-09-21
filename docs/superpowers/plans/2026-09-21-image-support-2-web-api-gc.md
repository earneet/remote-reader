# 图片支持 · Phase 2：Web API + 引用管理与 GC 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地图片上传三段式 API（init/relay/confirm）、双代理路由、shared 引用提取器单源（P1-3，含 math 规则抽取）、引用管理 R1 集合差、GC 三触发点与安全包不变量、tiering 调度器无条件启动（P1-2）。

**Architecture:** 提取器与魔数工具进 `packages/shared`（桥预检 Phase 4 复用；**math 规则从 web markdown.ts 抽到 shared 三方共用**——真单源防漂移）。服务层两文件：`images.ts`（init/relay/confirm/resolve + 名字分配，discriminated union 结果风格）与 `image-refs.ts`（登记 R1/快照/GC 检查/惰性补录/周期回收）。挂载点：`uploadDocument` 三分支、`deleteNode` 事务前后、`startTieringScheduler` 重构。

**Tech Stack:** 既有栈零新增依赖（markdown-it 已在 web 依赖——shared 需新增声明）。

**Spec:** `docs/superpowers/specs/2026-09-20-image-support-design.md` v4 §5（API）/§6.3（提取器单源）/§9（引用管理与 GC）/§4.3（安全包）。

**批次路线**：本批 = 路线图第 2 批。Phase 3 渲染消费本批的 `extractImageNames`/`lazyRegisterRefs`/代理路由。

## 运行纪律（同 Phase 1）

- 测试 `bun run test apps/web/tests/<file>`（worktree 根）；worktree 新副本先 `bun install` + `cd apps/web && bunx svelte-kit sync`
- 执行期经验（Phase 1 实录）：实现签名与调用点参数一致；`bun --filter add` 失败时在 apps/web 目录直接 `bun add`；LSP 不认 worktree 用 svelte-check 等效
- 每 Task 独立 commit，TDD 红→绿不跳步

---

### Task 1: math 规则抽取到 shared（三消费方单源的地基）

**Files:**
- Create: `packages/shared/src/markdown-math.ts`
- Modify: `apps/web/src/lib/server/markdown.ts`（删除内联规则，改 import）
- Test: `packages/shared/src/markdown-math.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import MarkdownIt from 'markdown-it';
import { registerMathRules } from './markdown-math';

// 与 web 渲染实例完全同构的配置：math 规则吞掉 $...$ 内的图片语法（P1-3 语义差锁定）
function md(): MarkdownIt {
    const m = new MarkdownIt({ html: false, linkify: true, typographer: true });
    registerMathRules(m);
    return m;
}

describe('markdown-math 共享规则', () => {
    it('$...$ 行内公式渲染为 math span 且不产生 image token', () => {
        const m = md();
        const tokens = m.parse('$![x](y.png)$', {});
        const hasMath = tokens.some((t) => t.children?.some((c) => c.type === 'math_inline'));
        const hasImage = tokens.some((t) => t.children?.some((c) => c.type === 'image'));
        expect(hasMath).toBe(true);
        expect(hasImage).toBe(false);
    });
    it('$$ 块公式同理', () => {
        const m = md();
        const tokens = m.parse('$$\n![x](y.png)\n$$', {});
        expect(tokens.some((t) => t.type === 'math_block')).toBe(true);
        expect(tokens.some((t) => t.children?.some((c) => c.type === 'image'))).toBe(false);
    });
    it('公式外的图片不受影响', () => {
        const m = md();
        const tokens = m.parse('前文 $a$ 然后 ![x](y.png)', {});
        expect(tokens.some((t) => t.children?.some((c) => c.type === 'image'))).toBe(true);
    });
});
```

- [ ] **Step 2: 确认失败**：`bun run test packages/shared/src/markdown-math.test.ts`——根 vitest.config.ts 的 include 覆盖 `packages/shared/src/**/*.test.ts`（实证），测试就放 shared 包内（`import './markdown-math'` 同目录相对导入，无需跨包路径）；markdown-it 经 bun workspace hoisted 从根 node_modules 解析。

```ts
import { registerMathRules } from '../../../packages/shared/src/markdown-math';
```

（$server alias 只覆盖 web src；跨包用相对路径。markdown-it 从 web node_modules 解析 ✓ hoisted）

- [ ] **Step 3: 实现 `packages/shared/src/markdown-math.ts`**——把 `apps/web/src/lib/server/markdown.ts:99-165` 的两个 ruler 注册 + 两个 renderer 规则**原样搬移**（含全部注释），导出：

```ts
import type MarkdownIt from 'markdown-it';

// （注释原样保留自 web markdown.ts 2026-09-20 抽取——math_inline/math_block 规则与渲染器）
// P1-3：此文件是 math 规则唯一事实源——web 渲染实例与本包提取器共用，
// 私有副本会造成 token 流漂移（$...$ 吞图语义差 → refs 漂移 → 活图被 GC）。
export function registerMathRules(md: MarkdownIt): void {
    // ...（99-161 行的 md.inline.ruler.before('escape', 'math_inline', ...) 与
    //     md.block.ruler.before('fence', 'math_block', ..., { alt: ['paragraph','reference'] }) 原样搬入）
}

export function registerMathRenderers(md: MarkdownIt): void {
    // ...（162-165 行的 renderer.rules.math_inline / math_block 原样搬入）
}
```

（执行者：搬移 = 从 markdown.ts 剪切对应代码段到本文件，字符级不变；上方省略号仅因计划不重复 60 行已存在代码——**这不是占位符，是"搬移既有代码"的显式指令**，源位置已给精确行号）

- [ ] **Step 4: web markdown.ts 改用**：删除 99-165 行内联定义，`getMarkdown` 内构建实例后调用 `registerMathRules(md); registerMathRenderers(md);`（import 自 `../../../packages/shared/src/markdown-math`——web 已有 `$shared` alias？AGENTS.md：`$shared`→`packages/shared/src` ✓ 用 `$shared/markdown-math`）。
- [ ] **Step 5: 跑新测试 + 既有 markdown 测试全绿**：`bun run test packages/shared/src/markdown-math.test.ts apps/web/tests/markdown.test.ts`（math 行为不变的回归锁定）。
- [ ] **Step 6: Commit** `feat(shared): math 规则抽取为单源（web 渲染与图片提取器共用，P1-3 地基）`

---

### Task 2: shared 提取器 extractImageNames（P1-3 核心）

**Files:**
- Create: `packages/shared/src/image-extract.ts`（**命名刻意避开 image-refs**——服务端 `apps/web/src/lib/server/image-refs.ts` 是另一物，同名混淆已在计划评审中实证（P2-4））
- Test: `packages/shared/src/image-extract.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect } from 'vitest';
import { extractImageNames } from './image-extract';

describe('extractImageNames（裸名提取单源）', () => {
    it('本地裸名提取', () => {
        expect(extractImageNames('![a](shot.png)')).toEqual(['shot.png']);
    });
    it('带 ./ 前缀与 query/fragment 剥离 + URL decode', () => {
        expect(extractImageNames('![a](./my%20shot.png?w=100#x)')).toEqual(['my shot.png']);
    });
    it('外链/data:/站内绝对路径不提取', () => {
        expect(extractImageNames('![a](https://x.com/a.png)![b](data:image/png;base64,xx)![c](/abs.png)')).toEqual([]);
    });
    it('引用式图片语法同样提取', () => {
        expect(extractImageNames('![a][r]\n\n[r]: logo.png')).toEqual(['logo.png']);
    });
    it('code block / inline code 内不提取', () => {
        expect(extractImageNames('```\n![a](x.png)\n```\n`![b](y.png)`')).toEqual([]);
    });
    it('math 内的图片语法不提取（与 web 渲染实例同构，P1-3 语义差锁定）', () => {
        expect(extractImageNames('$![x](y.png)$')).toEqual([]);
    });
    it('含路径分隔符的 src 不提取（仅裸名匹配 owner 池，spec #20）', () => {
        expect(extractImageNames('![a](sub/dir/x.png)')).toEqual([]);
    });
    it('重复引用去重保序', () => {
        expect(extractImageNames('![a](x.png)![b](x.png)![c](y.png)')).toEqual(['x.png', 'y.png']);
    });
});
```

- [ ] **Step 2: 确认失败**
- [ ] **Step 3: 实现 `packages/shared/src/image-extract.ts`**

（**Step 3 前置：`packages/shared/package.json`**——① `dependencies` 增 `"markdown-it": "<与 apps/web 同版本>"`；② `exports` 白名单增补 `"./markdown-math"`、`"./image-extract"`、`"./image-mime"` 三条（形状照 `./paths` 条目）；桥 bundle（Phase 4）与 web 生产构建都按 exports 解析，缺条目构建即失败）

```ts
import MarkdownIt from 'markdown-it';
import { registerMathRules } from './markdown-math';

// 图片引用名提取的单一事实源（spec P1-3）：桥预检（Phase 4）、Web 上传时声明式 refs 登记、
// Web 渲染 names[] 收集（Phase 3）三方强制共用——任何私有实现都会造成 refs 漂移 → 活图被 24h GC。
// math 规则必须注册：与 web 渲染实例同构，否则 $...$ 内图片被多提取（渲染端不渲染它）。
let cached: MarkdownIt | null = null;
function parser(): MarkdownIt {
    if (!cached) {
        cached = new MarkdownIt({ html: false, linkify: true, typographer: true });
        registerMathRules(cached);
    }
    return cached;
}

/** 提取 md 中本地图片引用的裸名（去重保序）。外链/data:/绝对路径/含分隔符路径/math 内/code 内不提取 */
export function extractImageNames(src: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>();
    const push = (raw: string): void => {
        // 与渲染端一致的归一化（spec #20）：URL decode → 去 query/fragment → 去 ./ 前缀
        let s = raw;
        const hashAt = s.search(/[?#]/);
        if (hashAt >= 0) s = s.slice(0, hashAt);
        try { s = decodeURIComponent(s); } catch { /* 非法编码按原样 */ }
        if (s.startsWith('./')) s = s.slice(2);
        if (!s || s.includes('/') || s.includes('\\')) return;    // 含分隔符：非裸名
        if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return;          // scheme（http/data/…）
        if (!seen.has(s)) { seen.add(s); out.push(s); }
    };
    const tokens = parser().parse(src, {});
    const walk = (toks: MarkdownIt.Token[]): void => {
        for (const t of toks) {
            if (t.type === 'image') {
                const raw = t.attrGet('src');
                if (raw) push(raw);
            }
            if (t.children) walk(t.children);
        }
    };
    walk(tokens);
    return out;
}
```

（markdown-it 依赖：`packages/shared/package.json` 的 dependencies 加 `markdown-it`（与 web 同版本）。esbuild 桥 bundle 时会带上——计划如此，Phase 6.1 已定）

- [ ] **Step 4: 确认通过** → **Step 5: Commit** `feat(shared): extractImageNames 图片引用提取单源（P1-3）`

---

### Task 3: shared 魔数工具 detectImageMime + 名字 sanitize

**Files:**
- Create: `packages/shared/src/image-mime.ts`
- Test: `apps/web/tests/img-mime.test.ts`

- [ ] **Step 1: 失败测试**（PNG/JPEG/GIF/WEBP 魔数、扩展名映射、SVG 拒绝文案、空格 sanitize）

```ts
import { describe, it, expect } from 'vitest';
import { detectImageMime, expectedExtFor, sanitizeImageName, SUPPORTED_IMAGE_EXTS } from '../../../packages/shared/src/image-mime';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2]);
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2]);
const GIF = Buffer.from('GIF89a', 'ascii');
const WEBP = Buffer.from('RIFF....WEBPVP8 ', 'latin1');

describe('image-mime', () => {
    it('四格式魔数识别', () => {
        expect(detectImageMime(PNG)).toBe('image/png');
        expect(detectImageMime(JPEG)).toBe('image/jpeg');
        expect(detectImageMime(GIF)).toBe('image/gif');
        expect(detectImageMime(WEBP)).toBe('image/webp');
    });
    it('未知/过短 → null（SVG 的拒绝理由在调用方文案）', () => {
        expect(detectImageMime(Buffer.from('<svg>'))).toBeNull();
        expect(detectImageMime(Buffer.alloc(2))).toBeNull();
    });
    it('扩展名映射与一致性', () => {
        expect(expectedExtFor('image/png')).toBe('png');
        expect(SUPPORTED_IMAGE_EXTS.sort()).toEqual(['gif', 'jpeg', 'jpg', 'png', 'webp']);
    });
    it('sanitize：空格→连字符，其余保留', () => {
        expect(sanitizeImageName('my shot 1.png')).toBe('my-shot-1.png');
        expect(sanitizeImageName('截图1.png')).toBe('截图1.png');
    });
});
```

- [ ] **Step 3: 实现**

```ts
// 图片魔数检测单源（spec #6）：桥预检（Phase 4）与 Web 服务端（relay/confirm 验证链）共用。
// SVG 不支持（XSS 面，spec §14）——拒绝文案由调用方给出。
export const SUPPORTED_IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'webp'] as const;

export function detectImageMime(b: Buffer): 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp' | null {
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
        && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png';
    if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
    if (b.length >= 6 && (b.subarray(0, 6).toString('latin1') === 'GIF87a'
        || b.subarray(0, 6).toString('latin1') === 'GIF89a')) return 'image/gif';
    if (b.length >= 12 && b.subarray(0, 4).toString('latin1') === 'RIFF'
        && b.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
    return null;
}

export function expectedExtFor(mime: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp'): string {
    return mime === 'image/png' ? 'png' : mime === 'image/jpeg' ? 'jpg' : mime === 'image/gif' ? 'gif' : 'webp';
}

/** 稳定名 sanitize（spec #2）：仅空格→`-`（引用/URL 编码链路边角），其余字符由 parsePath 单段校验拦截 */
export function sanitizeImageName(name: string): string {
    return name.replace(/ /g, '-');
}
```

- [ ] **Step 4/5: 绿 → Commit** `feat(shared): 图片魔数检测与名字 sanitize 单源`

---

### Task 4: images 服务层——init 四分支 + 名字分配

**Files:**
- Create: `apps/web/src/lib/server/images.ts`
- Test: `apps/web/tests/images-init.test.ts`

- [ ] **Step 1: 失败测试**

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db, schema, sqlite } from '$server/db';
import { resetDb } from './helpers';
import { initImage } from '$server/images';
import { eq } from 'drizzle-orm';

beforeEach(() => resetDb());

function mkUser(id: string): void {
    sqlite.exec(`INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('${id}', '${id}@t.local', 'x', 'member', 0)`);
}
function mkReadyImage(ownerId: string, name: string, hash: string): string {
    const id = `img-${hash.slice(0, 8)}`;
    sqlite.exec(`INSERT INTO images (id, owner_id, name, content_hash, content_md5, mime_type, size_bytes, status, storage_backend, storage_key, created_at, ready_at)
        VALUES ('${id}', '${ownerId}', '${name}', '${hash}', '${'m'.repeat(32)}', 'image/png', 10, 'ready', 'local', '${ownerId}/blobs/${hash.slice(0, 2)}/${hash}', 0, 0)`);
    return id;
}

describe('initImage 四分支（spec §5.1）', () => {
    it('新图：插 pending 行，local 后端返回 relay', () => {
        mkUser('u1');
        const r = initImage('u1', { name: 'shot.png', contentHash: 'a'.repeat(64), contentMd5: 'b'.repeat(32), sizeBytes: 100 });
        expect(r.status).toBe('relay');
        expect(r.name).toBe('shot.png');
        const row = db.select().from(schema.images).where(eq(schema.images.id, r.imageId)).get();
        expect(row?.status).toBe('pending');
        expect(row?.storageBackend).toBe('local');
    });
    it('exists：同 owner 同 hash ready 行 → 零流量复用注册名', () => {
        mkUser('u1');
        mkReadyImage('u1', 'old-name.png', 'c'.repeat(64));
        const r = initImage('u1', { name: 'new-name.png', contentHash: 'c'.repeat(64), contentMd5: 'd'.repeat(32), sizeBytes: 100 });
        expect(r).toEqual({ status: 'exists', name: 'old-name.png' });
    });
    it('pending 共享：同 hash pending 行 → 同 image_id 复用（不插新行）', () => {
        mkUser('u1');
        const first = initImage('u1', { name: 'a.png', contentHash: 'e'.repeat(64), contentMd5: 'f'.repeat(32), sizeBytes: 1 });
        const second = initImage('u1', { name: 'b.png', contentHash: 'e'.repeat(64), contentMd5: 'f'.repeat(32), sizeBytes: 1 });
        expect(second.imageId).toBe(first.imageId);
        expect(second.name).toBe('a.png'); // 响应返回行内注册名（spec #2 唯一权威）
    });
    it('墓碑复活：deleted 行 → 复活为 pending，全字段重置（P0-1：同名重传沿用原名——引用不断裂）', () => {
        mkUser('u1');
        const id = mkReadyImage('u1', 'tomb.png', '9'.repeat(64));
        sqlite.exec(`UPDATE images SET status='deleted', ready_at=5 WHERE id='${id}'`);
        const r = initImage('u1', { name: 'tomb.png', contentHash: '9'.repeat(64), contentMd5: '8'.repeat(32), sizeBytes: 7 });
        expect(r.status).toBe('relay');
        const row = db.select().from(schema.images).where(eq(schema.images.id, id)).get();
        expect(row?.status).toBe('pending');
        expect(row?.name).toBe('tomb.png'); // ← P0-1 关键断言：不得被自身占名强制改成 tomb-2.png
        expect(row?.readyAt).toBeNull();
        expect(row?.sizeBytes).toBe(7);       // 按新报值重置
        expect(row?.contentMd5).toBe('8'.repeat(32));
    });
    it('墓碑别名重传：请求名 != 行名 → 分配新名且不被墓碑旧名挤占', () => {
        mkUser('u1');
        const id = mkReadyImage('u1', 'tomb.png', '9'.repeat(64));
        sqlite.exec(`UPDATE images SET status='deleted' WHERE id='${id}'`);
        const r = initImage('u1', { name: 'fresh.png', contentHash: '9'.repeat(64), contentMd5: '8'.repeat(32), sizeBytes: 7 });
        expect(r.name).toBe('fresh.png'); // 墓碑自己的 tomb.png 不构成对 fresh.png 的占用
    });
    it('同名不同内容：自动后缀 -2..-N（精确探测，跨墓碑也占位）', () => {
        mkUser('u1');
        mkReadyImage('u1', 'shot.png', '1'.repeat(64));
        const r = initImage('u1', { name: 'shot.png', contentHash: '2'.repeat(64), contentMd5: '3'.repeat(32), sizeBytes: 1 });
        expect(r.name).toBe('shot-2.png');
    });
    it('hash/md5 格式校验（P0-1）：非法 → throw（路由层转 400，防 storage_key 路径穿越）', () => {
        mkUser('u1');
        expect(() => initImage('u1', { name: 'a.png', contentHash: '../../evil', contentMd5: 'x'.repeat(32), sizeBytes: 1 })).toThrow(/content_hash/);
        expect(() => initImage('u1', { name: 'a.png', contentHash: 'a'.repeat(64), contentMd5: 'zz', sizeBytes: 1 })).toThrow(/content_md5/);
    });
    it('超限 413 / 非法名 400（单段 parsePath 语义）', () => {
        mkUser('u1');
        expect(() => initImage('u1', { name: 'a.png', contentHash: 'a'.repeat(64), contentMd5: 'b'.repeat(32), sizeBytes: 11 * 1024 * 1024 })).toThrow(/上限/);
        expect(() => initImage('u1', { name: 'a/b.png', contentHash: 'a'.repeat(64), contentMd5: 'b'.repeat(32), sizeBytes: 1 })).toThrow(/name/);
    });
    it('owner 隔离：他 owner 的同 hash 行不命中 exists', () => {
        mkUser('u1'); mkUser('u2');
        mkReadyImage('u2', 'x.png', '7'.repeat(64));
        const r = initImage('u1', { name: 'x.png', contentHash: '7'.repeat(64), contentMd5: '6'.repeat(32), sizeBytes: 1 });
        expect(r.status).toBe('relay'); // u1 自己新建
    });
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现 `apps/web/src/lib/server/images.ts`（本任务先写 init 部分 + 类型）**

```ts
import { createHash } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { db, schema } from './db';
import { generateId } from './auth';
import { getBlobStore, getActiveImageStore } from './blobstore';
import { getMaxImageBytes } from './env';
import { sanitizeImageName } from '@remote-reader/shared/image-mime';
// shared 引入：包名是 @remote-reader/shared（连字符在 remote-reader 内——照 `@remote-reader/shared/paths` 先例）。
// exports 白名单前置步骤见 Task 2/3（本批显式增补 ./markdown-math、./image-refs、./image-mime 三条）。

const HEX64 = /^[0-9a-f]{64}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const NAME_SUFFIX_LIMIT = 16;

export type InitImageInput = { name: string; contentHash: string; contentMd5: string; sizeBytes: number };
export type InitImageResult =
    | { status: 'exists'; name: string }
    | { status: 'relay'; name: string; imageId: string }
    | { status: 'direct'; name: string; imageId: string; uploadUrl: string };

class ImageInputError extends Error {
    constructor(message: string, public status: 400 | 409 | 413) { super(message); this.name = 'ImageInputError'; }
}
export { ImageInputError };

function validateInitInput(input: InitImageInput): void {
    if (!HEX64.test(input.contentHash)) throw new ImageInputError('content_hash 须为 64 位小写 hex', 400); // P0-1：防 storage_key 路径穿越
    if (!HEX32.test(input.contentMd5)) throw new ImageInputError('content_md5 须为 32 位小写 hex', 400);
    if (typeof input.sizeBytes !== 'number' || input.sizeBytes < 0) throw new ImageInputError('size_bytes 非法', 400);
    if (input.sizeBytes > getMaxImageBytes()) throw new ImageInputError(`图片超过上限（${getMaxImageBytes()}B）`, 413);
    const name = sanitizeImageName(input.name);
    if (!name || name.includes('/') || name.includes('\\') || name === '.' || name === '..'
        || /[\x00-\x1f]/.test(name) || Buffer.byteLength(name, 'utf8') > 255) {
        throw new ImageInputError('name 须为单段合法文件名', 400);
    }
}

/** 名字分配：请求名可用直接用；被占（任何 status 的行——墓碑占位是特性）则后缀 -2..-16 精确探测。
 *  excludeId：复活场景排除自身行（P0-1：不排除则墓碑的现存名被自己"占用"，同名重传被强制 -2 改名 →
 *  裸名引用断裂 → 无 refs 二次 GC 丢数据） */
function allocateName(ownerId: string, requested: string, excludeId?: string): string {
    const taken = (n: string): boolean =>
        db.select({ id: schema.images.id }).from(schema.images)
            .where(and(
                eq(schema.images.ownerId, ownerId),
                eq(schema.images.name, n),
                excludeId === undefined ? undefined : ne(schema.images.id, excludeId)
            )).get() !== undefined;
    if (!taken(requested)) return requested;
    const dot = requested.lastIndexOf('.');
    const base = dot > 0 ? requested.slice(0, dot) : requested;
    const ext = dot > 0 ? requested.slice(dot) : '';
    for (let i = 2; i < 2 + NAME_SUFFIX_LIMIT; i++) {
        let cand = `${base}-${i}${ext}`;
        if (Buffer.byteLength(cand, 'utf8') > 255) cand = `${base.slice(0, base.length - 4)}-${i}${ext}`; // 超长截断基名再试
        if (!taken(cand)) return cand;
    }
    throw new ImageInputError(`"${requested}" 的同名后缀已达上限（${NAME_SUFFIX_LIMIT}）`, 409);
}

function storageKeyFor(backend: string, ownerId: string, hash: string): string {
    return backend === 's3' ? `images/${ownerId}/${hash}` : `${ownerId}/blobs/${hash.slice(0, 2)}/${hash}`;
}

export async function initImage(ownerId: string, input: InitImageInput): Promise<InitImageResult> {
    validateInitInput(input);
    const active = getActiveImageStore();
    const now = Date.now();
    for (let attempt = 0; ; attempt++) {
        if (attempt >= 4) throw new ImageInputError('init 并发冲突重试次数超限，请重试', 409); // 外壳统一上限（revive 对峙与 UNIQUE 撞击共用）
        const byHash = db.select().from(schema.images)
            .where(and(eq(schema.images.ownerId, ownerId), eq(schema.images.contentHash, input.contentHash))).get();
        if (byHash?.status === 'ready') return { status: 'exists', name: byHash.name };
        if (byHash && (byHash.status === 'pending' || byHash.status === 'deleted')) {
            let rowId = byHash.id;
            if (byHash.status === 'deleted') {
                // 墓碑复活（P0-1）：请求名 == 行名（同名重传，主场景）直接沿用原名——md 裸名引用不断裂；
                // 别名重传走 allocateName 且排除自身行（墓碑现存名不构成对新名的"占用"）
                const wanted = sanitizeImageName(input.name);
                const keepName = wanted === byHash.name
                    ? byHash.name
                    : allocateName(ownerId, wanted, byHash.id);
                const revived = db.update(schema.images).set({
                    status: 'pending', name: keepName,
                    contentMd5: input.contentMd5, sizeBytes: input.sizeBytes,
                    storageBackend: active.id, storageKey: storageKeyFor(active.id, ownerId, input.contentHash),
                    createdAt: now, readyAt: null
                }).where(and(eq(schema.images.id, byHash.id), eq(schema.images.status, 'deleted'))).run().changes > 0;
                if (!revived) continue; // 并发对峙：重查（对家已复活 → 走 pending 共享）
            }
            return await directOrRelay(rowId);
        }
        const name = allocateName(ownerId, sanitizeImageName(input.name));
        const id = generateId();
        try {
            db.insert(schema.images).values({
                id, ownerId, name, contentHash: input.contentHash, contentMd5: input.contentMd5,
                mimeType: 'image/png', // 占位：relay/confirm 验证后按实际魔数回写（pending 行 mime 无消费者）
                sizeBytes: input.sizeBytes, status: 'pending',
                storageBackend: active.id, storageKey: storageKeyFor(active.id, ownerId, input.contentHash),
                createdAt: now, readyAt: null
            }).run();
        } catch (e) {
            // 并发撞 UNIQUE（hash 或 name）→ 外壳重查（uploadDocument 先例；attempt 内不递归）
            if (e instanceof Error && (e as { code?: string }).code === 'SQLITE_CONSTRAINT_UNIQUE') continue;
            throw e;
        }
        return await directOrRelay(id);
    }
}

/** 按行的 storage_backend 决定 direct（presigned PUT）/relay（中转）——行内后端优先于 active（共享行可能属旧后端） */
async function directOrRelay(imageId: string): Promise<InitImageResult> {
    const row = db.select().from(schema.images).where(eq(schema.images.id, imageId)).get()!;
    const store = getBlobStore(row.storageBackend);
    if (store?.presign && store.id === 's3') {
        const uploadUrl = await store.presign('put', row.storageKey, store.uploadUrlTtlSeconds ?? 600);
        return { status: 'direct', name: row.name, imageId: row.id, uploadUrl };
    }
    return { status: 'relay', name: row.name, imageId: row.id };
}

- [ ] **Step 4: 测试绿**（direct 分支的测试：注入 fake s3 store——`__setBlobStoresForTest` 类型只有 local……**测试钩子需扩展**：`__setBlobStoresForTest(stores: { local: BlobStore; s3?: BlobStore } | undefined)`——blobstore.ts 微调三行：类型加可选 s3、buildRegistry 不变、钩子 Object.entries 已支持。此微调并入本 Task）→ **Step 5: Commit** `feat(web): images 服务层 init 四分支/名字后缀分配/墓碑复活（TDD）`

---

### Task 5: images 服务层——relay + confirm + resolveByName

**Files:**
- Modify: `apps/web/src/lib/server/images.ts`
- Test: `apps/web/tests/images-relay-confirm.test.ts`（新建）

- [ ] **Step 1: 失败测试**（要点用例，完整断言照 spec §5.2/§5.3）

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { db, schema, sqlite } from '$server/db';
import { resetDb } from './helpers';
import { initImage, relayImage, confirmImage, resolveImageByName } from '$server/images';
import { LocalBlobStore } from '$server/blobstore-local';
import { __setBlobStoresForTest } from '$server/blobstore';
import { createHash } from 'node:crypto'; // ESM import（vitest 无 require——P1-4）
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-img2-'));
process.env.DATA_DIR = DIR;

beforeEach(() => resetDb());
// PNG 8字节头 + 填充
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex');

describe('relayImage（spec §5.2）', () => {
    it('happy path：写盘 + ready + mime/size 实测回写 + sha256 字节绑定过', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        sqlite.exec(`INSERT INTO users (id,email,password_hash,role,created_at) VALUES ('u1','u1@t','x','member',0)`);
        const init = await initImage('u1', { name: 'a.png', contentHash: sha256(PNG), contentMd5: md5(PNG), sizeBytes: PNG.length });
        const r = await relayImage('u1', init.imageId!, PNG);
        expect(r.ok).toBe(true);
        const row = db.select().from(schema.images).where(eq(schema.images.id, init.imageId!)).get()!;
        expect(row.status).toBe('ready');
        expect(row.mimeType).toBe('image/png');
        expect(row.sizeBytes).toBe(PNG.length);
    });
    it('P1-1 字节绑定：谎报 hash → invalid（去重池投毒封死）', async () => {
        __setBlobStoresForTest({ local: new LocalBlobStore() });
        // init 报 hash X，relay 传的实际字节 hash 是 Y → invalid
        const init = await initImage('u1', { name: 'a.png', contentHash: 'a'.repeat(64), contentMd5: md5(PNG), sizeBytes: PNG.length });
        const r = await relayImage('u1', init.imageId!, PNG);
        expect(r).toEqual({ ok: false, reason: 'invalid', message: expect.stringContaining('hash') });
    });
    it('魔数不符 / 扩展名不一致 / SVG → invalid 带文案', async () => { /* 同构三用例：Buffer.from('<svg>…') → invalid（文案含 SVG）；.jpg 名 + PNG 字节 → invalid */ });
    it('P2-1 owner 作用域：非 owner 的 imageId → not_found', async () => { /* u2 调 u1 的行 → { ok:false, reason:'missing' } */ });
    it('条件式 UPDATE + 0 行回查：行已被 GC 删 → missing', async () => { /* 删行后 relay → missing（盘文件为无害孤儿） */ });
    it('重复 relay（已 ready）→ 幂等 ok（0 行回查 ready 分支）', async () => { /* 二次 relay 同行 → ok:true */ });
});

describe('confirmImage（spec §5.3，用 fake s3 store）', () => {
    // FakeStore：实现 BlobStore 的内存版（put/get/head 带 etag=getRange hash 简化），
    // 注入 __setBlobStoresForTest({ local: new LocalBlobStore(), s3: fakeS3 })
    it('三重验证过 → ready（etag==md5）', async () => { /* init(direct via fake presign) + fake.put + confirm → ok */ });
    it('对象缺失 → missing；etag 不符 → invalid+删对象', async () => { /* 两分支 */ });
    it('GC 后 confirm → missing（0 行回查分流，P1 of §4.3-5）', async () => { /* 删行后 confirm */ });
});

describe('resolveImageByName', () => {
    it('只认 ready（pending/deleted/无行 → null）', () => { /* 三态 */ });
});
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现（追加到 images.ts）**

```ts
import { detectImageMime, expectedExtFor } from '...image-mime'; // 同 Task4 的引入方式
import { ObjectNotFoundError, ArchiveUnavailableError } from './object-store';

export type RelayResult = { ok: true; name: string } | { ok: false; reason: 'missing' } | { ok: false; reason: 'invalid'; message: string };

export async function relayImage(ownerId: string, imageId: string, data: Buffer): Promise<RelayResult> {
    const row = db.select().from(schema.images).where(and(eq(schema.images.id, imageId), eq(schema.images.ownerId, ownerId))).get();
    if (!row) return { ok: false, reason: 'missing' };
    if (row.status === 'ready') return { ok: true, name: row.name };               // 幂等重放（0 行回查的 ready 分支）
    if (row.status !== 'pending') return { ok: false, reason: 'missing' };          // 墓碑/已删
    // 实测大小（spec §5.2 校验链第二环，P1-1）：init 报称 size 可谎报绕过预检，此处按真实字节拦截
    if (data.length > getMaxImageBytes()) {
        return { ok: false, reason: 'invalid', message: `图片实际大小 ${data.length}B 超过上限 ${getMaxImageBytes()}B` };
    }
    // P1-1 字节绑定：relay 是唯一内容真值时刻——sha256(buffer) 必须等于 init 报称 hash
    const actualHash = createHash('sha256').update(data).digest('hex');
    if (actualHash !== row.contentHash) return { ok: false, reason: 'invalid', message: `内容 hash 与 init 报称不符（去重池完整性拒绝）` };
    const mime = detectImageMime(data);
    if (mime === null) {
        const isSvg = data.subarray(0, 5).toString('latin1').startsWith('<');
        return { ok: false, reason: 'invalid', message: isSvg ? '不支持的图片格式（SVG 可携脚本，安全考虑不支持；支持 png/jpeg/gif/webp）' : '无法识别的图片格式（支持 png/jpeg/gif/webp）' };
    }
    const ext = row.name.split('.').pop()?.toLowerCase() ?? '';
    // 扩展名↔mime 一致性（jpeg 的 jpg/jpeg 双扩展惯例）
    const allowedExts: Record<string, string[]> = {
        'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'image/gif': ['gif'], 'image/webp': ['webp']
    };
    if (!(allowedExts[mime] ?? []).includes(ext)) {
        return { ok: false, reason: 'invalid', message: `扩展名 .${ext} 与实际格式 ${mime} 不一致，请改名重传` };
    }
    const store = getBlobStore(row.storageBackend);
    if (!store) return { ok: false, reason: 'invalid', message: '存储后端不可用' };
    await store.put(row.storageKey, data, mime);
    // 条件式 UPDATE + size/mime 实测回写；0 行 = 并发 GC/复活 → 回查分流（§4.3-5）
    const flipped = db.update(schema.images).set({
        status: 'ready', readyAt: Date.now(), mimeType: mime, sizeBytes: data.length
    }).where(and(eq(schema.images.id, row.id), eq(schema.images.status, 'pending'))).run().changes > 0;
    if (!flipped) {
        const recheck = db.select().from(schema.images).where(eq(schema.images.id, row.id)).get();
        if (recheck?.status === 'ready') return { ok: true, name: recheck.name };
        return { ok: false, reason: 'missing' };
    }
    return { ok: true, name: row.name };
}

export type ConfirmResult = { ok: true; name: string } | { ok: false; reason: 'missing' } | { ok: false; reason: 'invalid'; message: string };

export async function confirmImage(ownerId: string, imageId: string): Promise<ConfirmResult> {
    const row = db.select().from(schema.images).where(and(eq(schema.images.id, imageId), eq(schema.images.ownerId, ownerId))).get();
    if (!row) return { ok: false, reason: 'missing' };
    if (row.status === 'ready') return { ok: true, name: row.name };
    if (row.status !== 'pending') return { ok: false, reason: 'missing' };
    const store = getBlobStore(row.storageBackend);
    if (!store || !store.head || !store.getRange) return { ok: false, reason: 'invalid', message: '存储后端不支持验证（需 head/getRange 能力）' };
    let head: { size: number; etag?: string };
    try {
        head = await store.head(row.storageKey);
    } catch (e) {
        if (e instanceof ObjectNotFoundError) return { ok: false, reason: 'missing' };
        throw e; // ArchiveUnavailable → 路由层 503
    }
    if (head.size > getMaxImageBytes()) return { ok: false, reason: 'invalid', message: '对象超过大小上限' };
    const head32 = await store.getRange(row.storageKey, 0, 31);
    const mime = detectImageMime(head32);
    if (mime === null) return { ok: false, reason: 'invalid', message: '对象内容非支持图片格式' };
    // ETag==md5（S3 单段 PUT ETag 即内容 MD5）；local 后端无 etag（confirm 仅 direct/s3 路径调用，防御跳过）
    if (head.etag !== undefined && head.etag !== row.contentMd5) {
        try { await store.delete(row.storageKey); } catch { /* 留孤儿，无害 */ }
        return { ok: false, reason: 'invalid', message: '内容 md5 与 init 报称不符（ETag 校验失败）' };
    }
    const flipped = db.update(schema.images).set({
        status: 'ready', readyAt: Date.now(), mimeType: mime, sizeBytes: head.size
    }).where(and(eq(schema.images.id, row.id), eq(schema.images.status, 'pending'))).run().changes > 0;
    if (!flipped) {
        const recheck = db.select().from(schema.images).where(eq(schema.images.id, row.id)).get();
        if (recheck?.status === 'ready') return { ok: true, name: recheck.name };
        return { ok: false, reason: 'missing' };
    }
    return { ok: true, name: row.name };
}

/** 代理路由/渲染替换共用：owner 池按名查 ready 行（P2-2：name 由调用方 encodeURIComponent 进 URL，此处收到的是解码后） */
export function resolveImageByName(ownerId: string, name: string): { id: string; storageBackend: string; storageKey: string; mimeType: string; contentHash: string } | null {
    return db.select({
        id: schema.images.id, storageBackend: schema.images.storageBackend,
        storageKey: schema.images.storageKey, mimeType: schema.images.mimeType,
        contentHash: schema.images.contentHash
    }).from(schema.images)
        .where(and(eq(schema.images.ownerId, ownerId), eq(schema.images.name, name), eq(schema.images.status, 'ready')))
        .get() ?? null;
}
```

（afterAll 恢复 `delete process.env.DATA_DIR` + 清理 DIR，同 Phase 1 blobstore-local.test 模式）

- [ ] **Step 4/5: 绿 → Commit** `feat(web): images 服务层 relay/confirm/resolve（P1-1 字节绑定/条件式回查/ETag 校验，TDD）`

---

### Task 6: image-refs 服务层——登记 R1 / GC 安全包 / 周期回收

**Files:**
- Create: `apps/web/src/lib/server/image-refs.ts`
- Test: `apps/web/tests/image-refs.test.ts`

- [ ] **Step 1: 失败测试**（核心不变量逐条设场景；此处列用例名与关键断言，测试体执行者按 images-init.test 的 mk 辅助函数模式写全）

```
registerDocumentRefs（声明式登记）
  - 创建场景：names 匹配 ready 行 → INSERT；pending 行命中 → created_at 续期（P2-6）；无行 → 忽略
  - 覆盖场景 R1：old={I1,I2} new={I2,I3} → toAdd={I3} 先插、toRemove={I1} 后删、I2 原地不动（不变集零操作）
    ——断言：事务后 refs == {I2,I3}，且 I2 的 ref created_at 未变（证零操作）
  - R1 关键场景（spec §9.2 推演）：唯一引用者覆盖后仍引用 I → I 从未归零 → 不触发 GC（I 仍 ready）
  - toRemove 归零 → 软删墓碑 + blob 删除（fake store 断言 delete 调用过）+ 反查（§4.3-2：删除前有活行同 key → 跳过）
gcImagesIfUnreferenced
  - refs==0 → 条件式软删（UPDATE WHERE status='ready'）；已 deleted → 幂等跳过
snapshotRefsForDocuments / deleteNode 集成（Task 7 挂载）
lazyRegisterRefs（P1-4 content-hash 守卫）
  - hash 匹配 → INSERT；hash 不匹配（渲染期间被覆盖）→ 跳过
runImageGcCycle（周期回收，spec §9.3）
  - pending 超 1h：物理删行 + head 有对象则删（fake）；未超时不动
  - ready 无 refs 超 24h：软删 + 删 blob；有 refs 不动
  - 悬空 ref（指向非 ready 行）清理
  - 全部条件式：刚转正的行不被快照误删（pending 快照 → confirm 转正 → DELETE WHERE status='pending' 0 行跳过）
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现 `apps/web/src/lib/server/image-refs.ts`**

```ts
import { and, eq, inArray, lt, sql } from 'drizzle-orm';
import { db, schema } from './db';
import { getBlobStore } from './blobstore';
import { extractImageNames } from '@remote-reader/shared/image-extract';

type ImageRow = typeof schema.images.$inferSelect;

/** 声明式登记（文档创建/覆盖统一入口，R1 集合差原子重算，spec §9.2）。
 *  绝不允许"先删后判再插"的分步序列——不变量 R1。 */
export function registerDocumentRefs(ownerId: string, docId: string, mdContent: string): void {
    const names = extractImageNames(mdContent);
    const { toRemove } = db.transaction((tx): { toRemove: string[] } => {
        const oldRows = tx.select({ imageId: schema.imageRefs.imageId }).from(schema.imageRefs)
            .where(eq(schema.imageRefs.documentId, docId)).all();
        const oldIds = new Set(oldRows.map((r) => r.imageId));
        // 新引用集：owner 池内按名匹配 ready 行；pending 行命中则续期（P2-6）
        const newIds = new Set<string>();
        for (const name of names) {
            const row = tx.select({ id: schema.images.id, status: schema.images.status })
                .from(schema.images)
                .where(and(eq(schema.images.ownerId, ownerId), eq(schema.images.name, name))).get();
            if (!row) continue;
            if (row.status === 'ready') newIds.add(row.id);
            else if (row.status === 'pending') {
                tx.update(schema.images).set({ createdAt: Date.now() }).where(eq(schema.images.id, row.id)).run(); // 续期：防文本引用指向 pending 名被 1h 回收释放
            }
        }
        const now = Date.now();
        for (const id of [...newIds].filter((id) => !oldIds.has(id))) {          // 先加（R1）
            tx.insert(schema.imageRefs).values({ documentId: docId, imageId: id, createdAt: now })
                .onConflictDoNothing().run();
        }
        const toRemove = [...oldIds].filter((id) => !newIds.has(id));
        for (const id of toRemove) {                                              // 后删（R1）
            tx.delete(schema.imageRefs).where(and(eq(schema.imageRefs.documentId, docId), eq(schema.imageRefs.imageId, id))).run();
        }
        return { toRemove };
    });
    // GC 检查只对 toRemove、只在事务提交后、按终态（§4.3-4）
    void gcImagesIfUnreferenced(toRemove);
}

/** 归零检查 → 条件式软删墓碑 → 事务后按 key 反查删 blob（§4.3-1/2/4）。fire-and-forget。 */
export async function gcImagesIfUnreferenced(imageIds: string[]): Promise<void> {
    for (const id of imageIds) {
        db.transaction((tx) => {
            const refCount = tx.select({ n: sql<number>`count(*)` }).from(schema.imageRefs)
                .where(eq(schema.imageRefs.imageId, id)).get()?.n ?? 0;
            if (refCount > 0) return;
            tx.update(schema.images).set({ status: 'deleted' })
                .where(and(eq(schema.images.id, id), eq(schema.images.status, 'ready'))).run();
        });
        const row = db.select({ storageBackend: schema.images.storageBackend, storageKey: schema.images.storageKey })
            .from(schema.images).where(eq(schema.images.id, id)).get();
        if (row) void deleteBlobIfOrphaned(row.storageBackend, row.storageKey);
    }
}

/** §4.3-2：物理删 blob 前反查同 key 活行——封死"行删后重传同 key 新行 → 延迟 DELETE 误删活图" */
async function deleteBlobIfOrphaned(backend: string, key: string): Promise<void> {
    const active = db.select({ id: schema.images.id }).from(schema.images)
        .where(and(eq(schema.images.storageKey, key), inArray(schema.images.status, ['pending', 'ready']))).all();
    if (active.length > 0) return; // 有活行复用同 key（重传场景）：跳过，下轮再看
    const store = getBlobStore(backend);
    if (!store) return;
    try { await store.delete(key); } catch (e) { console.warn('[img-gc] blob 删除失败（孤儿，无害）', key, e); }
}

/** 渲染替换阶段惰性补录（P1-4：content-hash 守卫——渲染期间文档被覆盖则放弃补录，防僵尸 ref） */
export function lazyRegisterRefs(ownerId: string, docId: string, expectedContentHash: string, names: string[]): void {
    db.transaction((tx) => {
        const doc = tx.select({ contentHash: schema.documents.contentHash }).from(schema.documents)
            .where(eq(schema.documents.id, docId)).get();
        if (!doc || doc.contentHash !== expectedContentHash) return; // 渲染已过期：跳过
        const now = Date.now();
        for (const name of names) {
            const row = tx.select({ id: schema.images.id, status: schema.images.status }).from(schema.images)
                .where(and(eq(schema.images.ownerId, ownerId), eq(schema.images.name, name), eq(schema.images.status, 'ready'))).get();
            if (!row) continue;
            tx.insert(schema.imageRefs).values({ documentId: docId, imageId: row.id, createdAt: now })
                .onConflictDoNothing().run();
        }
    });
}

/** deleteNode 前快照：子树全部 file 行的 refs 图清单（事务内 CASCADE 前取，spec §9.3 触发一） */
export function snapshotRefsForDocuments(docIds: string[]): string[] {
    if (docIds.length === 0) return [];
    const rows = db.select({ imageId: schema.imageRefs.imageId }).from(schema.imageRefs)
        .where(inArray(schema.imageRefs.documentId, docIds)).all();
    return [...new Set(rows.map((r) => r.imageId))];
}

/** 周期回收（tiering tick 挂载，spec §9.3 触发三 + P1-2：无对象存储也必须运行）。
 *  分批 LIMIT；全部条件式；删 blob 反查。返回处理的行数（日志用）。 */
export async function runImageGcCycle(): Promise<{ pendingReaped: number; readyReaped: number; danglingRefs: number }> {
    const now = Date.now();
    const BATCH = 200;
    // 0) 悬空 ref 清理【必须最先跑——P1-3】：image_refs.image_id FK 是 ON DELETE no action 且
    //    pragma foreign_keys=ON——若悬空 ref 指向某 pending 行（防御对象正是这种历史坏态），
    //    后续物理删行会抛 SQLITE_CONSTRAINT_FOREIGNKEY 且中断整轮 GC；清理放在删除之前，
    //    收敛器才不会在坏态面前自杀（原顺序：第 1 步炸 → 第 3 步永远执行不到 → GC 永久卡死）
    const danglingRefs = sqlite_exec_dangling_cleanup();
    // 1) pending 超 1h：物理删行（条件式）+ 反查删 blob
    const stalePending = db.select({ id: schema.images.id }).from(schema.images)
        .where(and(eq(schema.images.status, 'pending'), lt(schema.images.createdAt, now - 3_600_000)))
        .limit(BATCH).all();
    let pendingReaped = 0;
    for (const p of stalePending) {
        const row = db.select({ storageBackend: schema.images.storageBackend, storageKey: schema.images.storageKey })
            .from(schema.images).where(eq(schema.images.id, p.id)).get();
        const deleted = db.delete(schema.images)
            .where(and(eq(schema.images.id, p.id), eq(schema.images.status, 'pending'))).run().changes > 0;
        if (deleted) { pendingReaped++; if (row) void deleteBlobIfOrphaned(row.storageBackend, row.storageKey); }
    }
    // 2) ready 无 refs 超 24h：软删墓碑 + 反查删 blob
    const staleReady = db.select({ id: schema.images.id }).from(schema.images)
        .where(and(eq(schema.images.status, 'ready'), lt(schema.images.readyAt, now - 24 * 3_600_000)))
        .limit(BATCH).all();
    let readyReaped = 0;
    const candidateIds = staleReady.map((r) => r.id);
    if (candidateIds.length > 0) {
        const refed = new Set(db.select({ imageId: schema.imageRefs.imageId }).from(schema.imageRefs)
            .where(inArray(schema.imageRefs.imageId, candidateIds)).all().map((r) => r.imageId));
        for (const id of candidateIds) {
            if (refed.has(id)) continue;
            const flipped = db.update(schema.images).set({ status: 'deleted' })
                .where(and(eq(schema.images.id, id), eq(schema.images.status, 'ready'))).run().changes > 0;
            if (flipped) {
                readyReaped++;
                const r = db.select({ storageBackend: schema.images.storageBackend, storageKey: schema.images.storageKey })
                    .from(schema.images).where(eq(schema.images.id, id)).get();
                if (r) void deleteBlobIfOrphaned(r.storageBackend, r.storageKey);
            }
        }
    return { pendingReaped, readyReaped, danglingRefs };
}

function sqlite_exec_dangling_cleanup(): number {
    return db.delete(schema.imageRefs).where(sql`
        ${schema.imageRefs.imageId} IN (SELECT id FROM ${schema.images} WHERE status != 'ready')
    `).run().changes;
}
```

（`ImageRow` 类型别名若在本文件无剩余消费者则不引入——以最终代码为准。提取器 import 按 `@remote-reader/shared/paths` 先例。）

- [ ] **Step 4/5: 绿（全部安全包不变量场景）→ Commit** `feat(web): image-refs 服务层——R1 集合差/GC 安全包/惰性补录守卫/周期回收（TDD）`

---

### Task 7: 挂载 documents.ts + tiering 调度器 P1-2

**Files:**
- Modify: `apps/web/src/lib/server/documents.ts`（uploadDocument 三处 + deleteNode）
- Modify: `apps/web/src/lib/server/tiering.ts`（startTieringScheduler）
- Test: `apps/web/tests/image-gc-triggers.test.ts`（新建）

- [ ] **Step 1: 失败测试**（集成场景）

```
- uploadDocument 新建带图 md → refs 登记（断言 image_refs 行存在）+ 未引用的 ready 图不受影响
- uploadDocument 覆盖移除引用（new md 不再含 I）→ I refs 归零 → 软删墓碑 + fake store delete 断言
- uploadDocument 覆盖仍引用（R1 场景）→ I 未被 GC（status 仍 ready、ref created_at 不变）
- uploadDocument 幂等分支 → refs 不重算（created_at 不变）
- deleteNode 删除含图文档 → 快照图归零 → 墓碑 + blob 删；被两文档引用的图 → 删一个仍在
- deleteNode 删文件夹（子树多 md）→ 子树全部 refs 处理
- P1-2：无 OBJECT_STORE_* 环境下 startTieringScheduler 启动且 runImageGcCycle 被调度
  （fake timers：vi.useFakeTimers + `advanceTimersByTimeAsync(1h)`（**必须 Async 版**——回调内 fire-and-forget promise 需微任务刷新，同步 advance 后立即断言必红）；断言 pending 行被物理删。
  ⚠️ schedulerStarted 模块级单例无重置钩子 → 该用例须独立测试文件且仅能调用一次 startTieringScheduler。
  ⚠️ 所有涉及 `void gcImagesIfUnreferenced(...)` / `void deleteBlobIfOrphaned(...)` 的断言前先 `await new Promise(r => setImmediate(r))` 刷新 fire-and-forget 微任务）
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现（三处挂载 + 调度器重构）**

documents.ts `uploadDocument`：
1. 新建成功分支：`indexDoc(id, name, content);` 之后插 `registerDocumentRefs(ownerId, id, content);`
2. 覆盖成功分支：锁内 `indexDoc(row.id, name, content);` 之后（仍在锁内、flipped 之后）插 `registerDocumentRefs(ownerId, row.id, content);`
3. 幂等分支（existing.contentHash === contentHash）：**零操作**（内容相同 → refs 终态相同，R1 集合差天然 no-op；不调用即不变 created_at）
4. import：`import { registerDocumentRefs, snapshotRefsForDocuments, gcImagesIfUnreferenced } from './image-refs';`

documents.ts `deleteNode`：事务前取快照、事务后触发 GC：

```ts
    // 图片 GC（spec §9.3 触发一）：CASCADE 删 refs 前快照受影响图清单，删后按终态归零检查
    const imageIdsForGc = snapshotRefsForDocuments(subtreeIds);
    db.transaction((tx) => { /* 原事务不动——documents 删除时 image_refs.document_id 的 ON DELETE CASCADE 自动清行 */ });
    // ……原事务后文件清理循环之后：
    void gcImagesIfUnreferenced(imageIdsForGc);
```

tiering.ts `startTieringScheduler` 重构（P1-2 代码实证修复）：

```ts
let schedulerStarted = false;
export function startTieringScheduler(): void {
    if (schedulerStarted) return;
    schedulerStarted = true;
    // P1-2（Oracle 代码实证）：原实现 store 为 null 直接 return——默认部署（local 图片后端、无对象存储）
    // 下调度器不存在，图片周期 GC 永不运行。修正：调度器无条件启动；归档循环保留 store 判空（分层仍可选）。
    void runArchiveCycle().then((n) => { if (n > 0) console.log('[tiering] 首轮归档完成', n, '篇'); })
        .catch((e) => console.warn('[tiering] 首轮归档失败（对象存储连通性待确认）', e));
    const timer = setInterval(() => {
        void runArchiveCycle().catch((e) => console.warn('[tiering] 归档周期失败', e));
        void runImageGcCycle().then((r) => {
            if (r.pendingReaped + r.readyReaped + r.danglingRefs > 0) {
                console.log('[img-gc] 周期回收', JSON.stringify(r));
            }
        }).catch((e) => console.warn('[img-gc] 周期回收失败', e));
    }, TIERING_INTERVAL_MS);
    timer.unref();
}
```

（`runArchiveCycle` 内已有 `if (!s) return 0;` 判空 ✓ 无需改；import runImageGcCycle 自 './image-refs'——注意循环依赖：image-refs.ts import blobstore.ts import env/object-store——不经过 tiering ✓；documents.ts ↔ image-refs.ts 无环（image-refs 不 import documents）✓）

- [ ] **Step 4/5: 绿 + 全量回归 → Commit** `feat(web): refs 挂载 uploadDocument/deleteNode + tiering 调度器无条件启动（P1-2，TDD）`

---

### Task 8: 五个 API 路由 + 收尾

**Files:**
- Create: `apps/web/src/routes/api/v1/images/init/+server.ts`、`apps/web/src/routes/api/v1/images/+server.ts`、`apps/web/src/routes/api/v1/images/confirm/+server.ts`、`apps/web/src/routes/s/[token]/i/[name]/+server.ts`、`apps/web/src/routes/d/[id]/i/[name]/+server.ts`
- Test: `apps/web/tests/images-api.test.ts`（新建）

- [ ] **Step 1: 失败测试**（路由集成，复用现有 API 测试的 fetch 模式——对照 `apps/web/tests` 既有 API 测试的 server fixture 方式；用例：）

```
init 路由：401 无 token / 轻桶 429 / 400 hash 格式 / 413 超限 / 三态响应形状
relay 路由：401 / owner 作用域 / invalid 文案（SVG） / ready 幂等 / 错误形状 {"message"}
confirm 路由：missing/invalid/ok 三态
/s/[token]/i/[name]：合法 token+refs 命中 → 200 + Content-Type + nosniff + no-cache + ETag==hash；
  If-None-Match 命中 → 304（无 body）；token 无效/图非该 md 引用/图不存在 → 404；pending 图 → 404
/d/[id]/i/[name]：session 鉴权（非 owner 404）
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现五个路由**

`api/v1/images/init/+server.ts`（认证/限流块照 `/api/v1/documents/+server.ts` 1-29 行同款——authfail IP 桶 + Bearer）：

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticateApiToken } from '$server/apitoken-auth';
import { checkRateLimit } from '$server/ratelimit';
import { initImage, ImageInputError } from '$server/images';
import { envInt } from '$server/env';

const IMAGES_META_RATE_LIMIT = { max: envInt('IMAGES_META_RATE_LIMIT_MAX', 120), windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000) };
const AUTH_FAIL_RATE_LIMIT = { max: envInt('AUTH_FAIL_RATE_LIMIT_MAX', 30), windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000) };

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
    const auth = authenticateApiToken(request.headers.get('authorization'));
    if (!auth) {
        const rl = checkRateLimit(`authfail:${getClientAddress()}`, AUTH_FAIL_RATE_LIMIT);
        if (!rl.allowed) error(429, 'too many failed auth attempts, slow down');
        error(401, 'invalid or missing api token');
    }
    const rl = checkRateLimit(`images-meta:${auth.tokenId}`, IMAGES_META_RATE_LIMIT);
    if (!rl.allowed) error(429, 'rate limit exceeded');
    const body = await request.json().catch(() => null);
    const raw = (body ?? {}) as { name?: unknown; content_hash?: unknown; content_md5?: unknown; size_bytes?: unknown };
    if (typeof raw.name !== 'string' || typeof raw.content_hash !== 'string'
        || typeof raw.content_md5 !== 'string' || typeof raw.size_bytes !== 'number') {
        error(400, 'name, content_hash, content_md5, size_bytes required');
    }
    try {
        const result = await initImage(auth.userId, {
            name: raw.name, contentHash: raw.content_hash, contentMd5: raw.content_md5, sizeBytes: raw.size_bytes
        });
        return json(result);
    } catch (e) {
        if (e instanceof ImageInputError) error(e.status, e.message);
        throw e;
    }
};
```

`api/v1/images/+server.ts`（relay，重桶 `upload:${tokenId}` 同 documents）：

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticateApiToken } from '$server/apitoken-auth';
import { checkRateLimit } from '$server/ratelimit';
import { relayImage } from '$server/images';
import { envInt } from '$server/env';

const RATE_LIMIT = { max: envInt('RATE_LIMIT_MAX', 60), windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000) };
const AUTH_FAIL_RATE_LIMIT = { max: envInt('AUTH_FAIL_RATE_LIMIT_MAX', 30), windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000) };

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
    const auth = authenticateApiToken(request.headers.get('authorization'));
    if (!auth) {
        const rl = checkRateLimit(`authfail:${getClientAddress()}`, AUTH_FAIL_RATE_LIMIT);
        if (!rl.allowed) error(429, 'too many failed auth attempts, slow down');
        error(401, 'invalid or missing api token');
    }
    const rl = checkRateLimit(`img-relay:${auth.tokenId}`, RATE_LIMIT); // 独立重桶（P1-2）：与 documents 的 upload: 桶分离——50 图文档不被文档上传挤爆
    if (!rl.allowed) error(429, 'rate limit exceeded');
    const body = await request.json().catch(() => null);
    const raw = (body ?? {}) as { image_id?: unknown; content_base64?: unknown };
    if (typeof raw.image_id !== 'string' || typeof raw.content_base64 !== 'string') error(400, 'image_id and content_base64 required');
    let data: Buffer;
    try {
        data = Buffer.from(raw.content_base64, 'base64');
    } catch {
        error(400, 'invalid base64');
    }
    // base64 解码对无效字符是宽松忽略的——不在此做严格校验：内容真值由 relayImage 的
    // sha256 字节绑定（P1-1）权威兜底，谎报/截断的字节必然 hash 不符 → invalid
    const result = await relayImage(auth.userId, raw.image_id, data);
    if (result.ok) return json({ name: result.name });
    if (result.reason === 'missing') error(404, 'image not found');
    return json({ status: 'invalid', reason: result.message }, 400); // 与 confirm 同形状（P2-5：桥按 status 字段统一判别）
};
```

`api/v1/images/confirm/+server.ts`：同 init 的认证/轻桶块，Body `{image_id}`，`confirmImage` 三态 → `json({status:'ok', name})` / `json({status:'missing'}, 404)` / `error(400, message)`（invalid 语义 spec §5.3 带 reason——用 `json({ status: 'invalid', reason: message }, 400)` 保持机器可判别）。

`s/[token]/i/[name]/+server.ts`（代理路由，spec §5.4）：

```ts
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDocumentIdByShareToken } from '$server/shares';
import { db, schema } from '$server/db';
import { eq } from 'drizzle-orm';
import { resolveImageByName } from '$server/images';
import { getBlobStore } from '$server/blobstore';
import { ObjectNotFoundError, ArchiveUnavailableError } from '$server/object-store';

export const GET: RequestHandler = async ({ params, request, setHeaders }) => {
    const documentId = getDocumentIdByShareToken(params.token);
    if (!documentId) error(404, 'Not Found');
    const doc = db.select({ ownerId: schema.documents.ownerId }).from(schema.documents)
        .where(eq(schema.documents.id, documentId)).get();
    if (!doc) error(404, 'Not Found');
    // refs 白名单（spec #8）：该 md 必须引用此图——share token 不能枚举 owner 其他图
    const img = resolveImageByName(doc.ownerId, params.name);
    if (!img) error(404, 'Not Found');
    const refed = db.select({ x: schema.imageRefs.documentId }).from(schema.imageRefs)
        .where(eq(schema.imageRefs.imageId, img.id)).all().some((r) => r.x === documentId);
    if (!refed) error(404, 'Not Found');
    // no-cache 协商（spec #26）：ETag=content_hash，命中 If-None-Match → 304 无 body
    const etag = `"${img.contentHash}"`;
    if (request.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache' } });
    }
    const store = getBlobStore(img.storageBackend);
    if (!store) error(503, 'image backend unavailable');
    let data: Buffer;
    try {
        data = await store.get(img.storageKey);
    } catch (e) {
        if (e instanceof ObjectNotFoundError) error(404, 'Not Found');
        if (e instanceof ArchiveUnavailableError) error(503, 'image storage unreachable');
        throw e;
    }
    setHeaders({
        'Content-Type': img.mimeType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
        ETag: etag
    });
    return new Response(new Uint8Array(data));
};
```

（`params.name` 为 SvelteKit 解码后的裸名 ✓ 与 resolveImageByName 口径一致；404 统一口径不泄漏存在性；v1 无 Range）

`d/[id]/i/[name]/+server.ts`：同上，鉴权段替换为 `if (!locals.user) error(401)` + doc.ownerId === locals.user.id 校验（其余含 refs 白名单完全一致）。

- [ ] **Step 4: 路由测试绿 + 全量回归 + svelte-check** → **Step 5: Commit** `feat(web): 图片 API 五路由——init/relay/confirm/双代理（refs 白名单/no-cache+ETag/304，TDD）`

---

## Self-Review 记录

1. **Spec 覆盖**：§5.1-5.5 全部（init 四分支/relay 校验链/confirm 三重验证/双代理路由）✓；§6.3 提取器单源 ✓（math 抽取是 P1-3 的完整解）；§9.1-9.5 全部（R1/三触发点/安全包/收敛/名字语义）✓；§4.3 五不变量逐条有测试场景 ✓；P1-2 调度器 ✓；P0-1 hash 校验 ✓；P1-1 字节绑定 ✓；P2-1 owner 作用域 ✓；P2-6 续期 ✓。**不在本批**：IMAGE_SIGNED_URL_TTL/IMAGE_PROXY_ALL（Phase 3 渲染消费）、presign GET（Phase 3）、onerror（Phase 5 前端）。
2. **代码终态**：全部代码块为实现终态（无结构示意/执行注残留——自审轮已将 initImage 草稿、registerDocumentRefs 占位函数、重复 blob 清理函数收敛为终态）；Task 1 的 math 搬移是显式行号指令（源代码已存在，不重复 60 行）。
3. **类型一致性**：InitImageResult/RelayResult/ConfirmResult discriminated union 三态与路由层 json/error 映射一一对应；`__setBlobStoresForTest` 扩展可选 s3（Task 4 并入，Task 5 fake 依赖它）。
4. **依赖方向**：image-refs.ts → {db/blobstore/shared}，images.ts → {db/auth/blobstore/env/shared}，均不 import documents/tiering（documents → image-refs 单向）；无环。
