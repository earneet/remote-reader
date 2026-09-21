# 图片支持 · Phase 3：渲染管线（两函数分离 · 占位符替换 · CDN 直连）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 渲染管线两段式落地——渲染阶段产占位符 HTML（进 RENDER_CACHE），替换阶段每请求解析图片（URL 决策树：代理/桶对齐 presign 直连/裂图占位）+ refs 惰性补录接线 + 客户端 onerror 兜底。

**Architecture:** `renderMarkdown(src)` 返回值变 `{ html, names, contentHash }`（RENDER_CACHE value 同构变化）；新 `images-resolve.ts` 承载替换阶段（决策树 + presign URL 桶缓存 + lazyRegisterRefs 接线）；归一化逻辑下沉 shared `normalizeImageRef`（渲染 renderer 与提取器真单源，防索引错位）。presign 桶对齐用**结果缓存方案**（`Map<imageId, {url, bucket}>`，同桶复用首签 URL——不依赖 SDK `signingDate` 选项）。

**Tech Stack:** 既有栈零新增依赖。spec §7（7.1-7.5）/§12（IMAGE_SIGNED_URL_TTL、IMAGE_PROXY_ALL）。

**批次路线**：第 3/5 批。前置已就绪：shared `extractImageNames`、`resolveImageByName`、`lazyRegisterRefs`、双代理路由、`getBlobStore`/presign。

## 运行纪律（同 Phase 1/2 + 实录经验）

worktree 新副本 `bun install` + `cd apps/web && bunx svelte-kit sync`；TDD 红→绿；`json(body, {status})` 对象参数；dev 冒烟后确认进程退净再跑全量；测试覆盖 tests/**/*.ts（联合类型 narrow）。

---

### Task 1: env getter + .env.example

**Files:** Modify `apps/web/src/lib/server/env.ts`、`.env.example`；Test `apps/web/tests/env.test.ts`（扩展，afterEach 键清单同步加两键）

- [ ] 失败测试（追加 describe；沿用现有 afterEach 清理模式）：

```ts
describe('getImageSignedUrlTtl / getImageProxyAll', () => {
    it('默认 3600 / 关闭', () => {
        delete process.env.IMAGE_SIGNED_URL_TTL;
        delete process.env.IMAGE_PROXY_ALL;
        expect(getImageSignedUrlTtl()).toBe(3600);
        expect(getImageProxyAll()).toBe(false);
    });
    it('自定义值 / 开启', () => {
        process.env.IMAGE_SIGNED_URL_TTL = '7200';
        process.env.IMAGE_PROXY_ALL = '1';
        expect(getImageSignedUrlTtl()).toBe(7200);
        expect(getImageProxyAll()).toBe(true);
        delete process.env.IMAGE_SIGNED_URL_TTL;
        delete process.env.IMAGE_PROXY_ALL;
    });
    it('非法值 fail-fast', () => {
        process.env.IMAGE_SIGNED_URL_TTL = '0';
        expect(() => getImageSignedUrlTtl()).toThrow();
        process.env.IMAGE_SIGNED_URL_TTL = 'abc';
        expect(() => getImageSignedUrlTtl()).toThrow();
        process.env.IMAGE_PROXY_ALL = 'yes';
        expect(() => getImageProxyAll()).toThrow(/IMAGE_PROXY_ALL/);
        delete process.env.IMAGE_SIGNED_URL_TTL;
        delete process.env.IMAGE_PROXY_ALL;
    });
});
```

- [ ] 确认失败 → 实现（env.ts 末尾）：

```ts
// 取图签名有效期秒（桶对齐下实际最短有效期 = TTL，同桶内 URL 稳定复用——spec §7.3/§12）
export function getImageSignedUrlTtl(): number {
    return envInt('IMAGE_SIGNED_URL_TTL', 3600);
}

// 强制全代理（隐蔽优先：不向读者暴露云存储域名；默认 0 = 直连，spec #10）
export function getImageProxyAll(): boolean {
    const raw = process.env.IMAGE_PROXY_ALL ?? '0';
    if (raw !== '0' && raw !== '1') {
        throw new Error(`env IMAGE_PROXY_ALL 须为 0 或 1，实际值: ${JSON.stringify(raw)}`);
    }
    return raw === '1';
}
```

- [ ] .env.example 图片区追加两条注释条目：

```
# 取图签名有效期秒（s3 后端直连 CDN 用；桶对齐缓存下同桶 URL 稳定）
# IMAGE_SIGNED_URL_TTL=3600
# 强制图片全走代理（不暴露云存储域名；默认 0=CDN 直连）
# IMAGE_PROXY_ALL=0
```

- [ ] 绿 → Commit `feat(web): 图片渲染 env——IMAGE_SIGNED_URL_TTL/IMAGE_PROXY_ALL（TDD）`

---

### Task 2: shared normalizeImageRef 归一化单源

**Files:** Modify `packages/shared/src/image-extract.ts`、`packages/shared/src/image-extract.test.ts`

- [ ] 失败测试（追加用例）：

```ts
import { normalizeImageRef } from './image-extract';

describe('normalizeImageRef（归一化单源——渲染 renderer 与提取器共用）', () => {
    it('裸名原样', () => { expect(normalizeImageRef('shot.png')).toBe('shot.png'); });
    it('./ 前缀剥离 + query/fragment 剥离 + decode', () => {
        expect(normalizeImageRef('./my%20shot.png?w=1#x')).toBe('my shot.png');
    });
    it('外链/站内绝对/data: → null（渲染原样输出的判定）', () => {
        expect(normalizeImageRef('https://x.com/a.png')).toBeNull();
        expect(normalizeImageRef('/abs.png')).toBeNull();
        expect(normalizeImageRef('data:image/png;base64,x')).toBeNull();
    });
    it('含路径分隔符 → null', () => { expect(normalizeImageRef('sub/dir.png')).toBeNull(); });
    it('非法百分号编码 → 原样返回（不炸）', () => { expect(normalizeImageRef('a%zz.png')).toBe('a%zz.png'); });
});
```

- [ ] 实现：把 `extractImageNames` 内 `push()` 的归一化段提取为导出函数（逻辑逐字搬移），`push` 改调它：

```ts
/** 图片引用归一化（单源）：query/fragment 剥离 → URL decode → ./ 剥离 → 非裸名（分隔符/scheme）判 null。
 *  extractImageNames 与 web 渲染 image renderer 共用——两处漂移会造成占位符索引错位。 */
export function normalizeImageRef(raw: string): string | null {
    let s = raw;
    const hashAt = s.search(/[?#]/);
    if (hashAt >= 0) s = s.slice(0, hashAt);
    try { s = decodeURIComponent(s); } catch { /* 非法编码按原样 */ }
    if (s.startsWith('./')) s = s.slice(2);
    if (!s || s.includes('/') || s.includes('\\')) return null;
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(s)) return null;
    return s;
}
```

（extractImageNames 的 push 改为：`const n = normalizeImageRef(raw); if (n && !seen.has(n)) {...}`——行为与现有 8 用例完全一致，测试零改动即绿）

- [ ] 绿（新 5 用例 + 既有 8 用例）→ Commit `feat(shared): normalizeImageRef 归一化单源（渲染/提取共用防索引错位）`

---

### Task 3: renderMarkdown 两函数分离 + 占位符 + image renderer

**Files:** Modify `apps/web/src/lib/server/markdown.ts`；Test `apps/web/tests/markdown.test.ts`（适配 + 新用例）

- [ ] 失败测试（**先适配既有断言**：该文件所有 `renderMarkdown(x)` 结果取用从 string 改 `.html`——机械替换 `(await renderMarkdown(...))` 为 `(await renderMarkdown(...)).html`；然后追加新 describe）：

```ts
describe('渲染管线两段式（占位符阶段）', () => {
    it('裸名图片输出占位符 src（含内容 hash 前 8 + 索引）+ lazy/decoding', async () => {
        const r = await renderMarkdown('![a](shot.png)');
        expect(r.names).toEqual(['shot.png']);
        expect(r.html).toMatch(/<img src="%%RR:IMG:[0-9a-f]{8}:0%%"[^>]*loading="lazy"[^>]*decoding="async"/);
        expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });
    it('外链/data:/绝对路径/含分隔符 src 原样输出（不占位）', async () => {
        const r = await renderMarkdown('![a](https://x.com/a.png)![b](data:image/png;base64,x)![c](sub/d.png)');
        expect(r.html).toContain('src="https://x.com/a.png"');
        expect(r.html).toContain('src="data:image/png;base64,x"');
        expect(r.html).toContain('src="sub/d.png"');
        expect(r.names).toEqual([]);
    });
    it('重复引用同图共用索引（names 去重保序一致）', async () => {
        const r = await renderMarkdown('![a](x.png)![b](x.png)');
        expect(r.html.match(/%%RR:IMG:[0-9a-f]{8}:0%%/g)?.length).toBe(2);
    });
    it('alt 转义保留', async () => {
        const r = await renderMarkdown('![<b>alt</b>](x.png)');
        expect(r.html).toContain('alt="&lt;b&gt;alt&lt;/b&gt;"');
    });
    it('缓存命中返回同构结果（value 结构 {html,names,contentHash}）', async () => {
        const a = await renderMarkdown('# t ![x](a.png)');
        const b = await renderMarkdown('# t ![x](a.png)');
        expect(b).toEqual(a); // 深比较：缓存 value 是同一对象引用也过；关键是结构完整
    });
});
```

- [ ] 确认失败 → 实现（markdown.ts 改造，核心变化）：

```ts
import { extractImageNames, normalizeImageRef } from '@remote-reader/shared/image-extract';

// RENDER_CACHE value 两段式：渲染阶段产物（占位符 HTML + names + 内容 hash）——替换阶段每请求执行
const RENDER_CACHE = new Map<string, { html: string; names: string[]; contentHash: string }>();

export async function renderMarkdown(src: string): Promise<{ html: string; names: string[]; contentHash: string }> {
    const contentHash = createHash('sha256').update(src, 'utf8').digest('hex');
    const hit = RENDER_CACHE.get(contentHash);
    if (hit !== undefined) return hit;
    const md = await getMarkdown();
    // names 单源来自 extractImageNames（P1-3）；renderer 的归一化用同一 normalizeImageRef（防索引错位）
    const names = extractImageNames(src);
    const stub = contentHash.slice(0, 8);
    const defaultImage = md.renderer.rules.image; // 保留默认渲染器语义（alt/title/attr 转义由它兜底）
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const raw = token.attrGet('src') ?? '';
        const norm = normalizeImageRef(raw);
        if (norm !== null) {
            const n = names.indexOf(norm);
            if (n >= 0) {
                token.attrSet('src', `%%RR:IMG:${stub}:${n}%%`);
                // referrerpolicy 渲染期预置（spec §7.3/§16）：仅裸名图（将占位符化者）。
                // 替换阶段只换 URL 字符串，无法向 <img> 标签追加属性——presign 直连图发 origin 供
                // 七牛 Referer 白名单；代理路径同属性无害（同源请求不受影响）
                token.attrSet('referrerpolicy', 'strict-origin-when-cross-origin');
            }
        }
        token.attrSet('loading', 'lazy');
        token.attrSet('decoding', 'async');
        return defaultImage!(tokens, idx, options, env, self);
    };
    let html: string;
    try {
        html = md.render(src);
    } finally {
        md.renderer.rules.image = defaultImage; // 实例单例——渲染后恢复（占位符 stub 逐次不同）
    }
    const result = { html, names, contentHash };
    if (RENDER_CACHE.size >= RENDER_CACHE_MAX) {
        const first = RENDER_CACHE.keys().next().value;
        if (first !== undefined) RENDER_CACHE.delete(first);
    }
    RENDER_CACHE.set(contentHash, result);
    return result;
}
```

**（执行注——renderer 竞态：mdInstance 单例 + renderer.rules.image 每次 render 前设置/后恢复，因 better-sqlite3/node 单线程且 render 同步，无并发交错；但 stub 每次渲染不同 → 恢复必要，防后续无占位需求渲染误用旧 stub。`token.attrSet` 顺序：先 src 后 loading/decoding（属性顺序不影响断言的 match 正则）。）**

- [ ] 绿（新 5 + 既有全适配）→ **同步适配其余 renderMarkdown 调用方**：`s/[token]/+page.server.ts` 与 `d/[id]/+page.server.ts` 的 `const html = await renderMarkdown(content);` 临时改为 `const html = (await renderMarkdown(content)).html;`（Task 5 再完整接线——本任务保绿不破）→ 全量回归 → Commit `feat(web): renderMarkdown 两函数分离——占位符渲染阶段（{html,names,contentHash}，TDD）`

---

### Task 4: images-resolve.ts——替换阶段（决策树/桶缓存/裂图/补录）

**Files:** Create `apps/web/src/lib/server/images-resolve.ts`；Test `apps/web/tests/images-resolve.test.ts`

- [ ] 失败测试（场景清单，正路建图：initImage+relayImage；FakeS3 注入 `__setBlobStoresForTest`；`/s/` 与 `/d/` 两 ctx 形态）：

```
- 代理路由 URL：local 后端 + share ctx → src=/s/<token>/i/<encodeURIComponent(name)>（含空格名编码断言）
- owner ctx → /d/<docId>/i/... 前缀
- IMAGE_PROXY_ALL=1 → local 与 s3 行全部走代理（presign 不调用——FakeS3 计数器断言）
- s3 行（FakeS3）→ presign URL 直连 + referrerpolicy="strict-origin-when-cross-origin" 属性在 img 上
- 桶对齐：fake timers 锁时间 → 同桶两次 resolveImages 产出逐字节相同 URL；
  advance 到下一桶 → URL 变化（重签）
- s3 行但 store 未注册（清 OBJECT_STORE_* 注入只有 local）→ 裂图占位 span（title 含"存储后端"）
- 无行/pending 图名 → 裂图占位 span（rr-img-missing + title 原因 + 🖼 [name]）
- refs 惰性补录：resolveImages 后 image_refs 行存在（lazyRegisterRefs 接线证据）；
  contentHash 过期守卫（改 documents.content_hash 后 resolve → refs 不增）
- 替换完整性：多图 md（代理+直连+裂图混合）→ 输出无残留 %%RR:IMG（全部替换）
- 防冲突：md 正文里手工写死伪造占位符 %%RR:IMG:deadbeef:0%%（hash 段不同于真实内容 hash）
  → 替换后伪造串原样保留（自指不可能构造的验证）
- 裂图占位内 name 过 escapeHtml（名字含 < 会被 init 拒——用 & 断言）
```

- [ ] 确认失败 → 实现：

```ts
import { resolveImageByName } from './images';
import { getBlobStore } from './blobstore';
import { getImageSignedUrlTtl, getImageProxyAll } from './env';
import { lazyRegisterRefs } from './image-refs';

export type ResolveCtx =
    | { kind: 'share'; token: string; ownerId: string; docId: string; contentHash: string }
    | { kind: 'owner'; ownerId: string; docId: string; contentHash: string };

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// presign URL 桶缓存（spec §7.3 桶对齐）：同桶内复用首签 URL（逐字节相同 → 浏览器缓存命中）。
// 不依赖 SDK signingDate——用结果缓存；expiresIn = TTL + 桶宽 保证桶末仍有效（envTtl 语义=最短有效期）。
const presignCache = new Map<string, { bucket: number; url: string }>();
const PRESIGN_CACHE_MAX = 256;

// 仅供测试：清空桶缓存（桶对齐确定性测试前置）
export function __resetPresignCacheForTest(): void {
    presignCache.clear();
}

/** 替换阶段（每请求执行，缓存命中也走到，spec §7.2）：占位符 → 最终 URL/裂图占位 + refs 惰性补录 */
export async function resolveImages(html: string, names: string[], ctx: ResolveCtx): Promise<string> {
    const ttl = getImageSignedUrlTtl();
    const bucketMs = (ttl * 1000) / 6;
    const bucket = Math.floor(Date.now() / bucketMs);
    const proxyAll = getImageProxyAll();
    const urls: string[] = [];
    for (const name of names) {
        const row = resolveImageByName(ctx.ownerId, name);
        if (!row) {
            urls.push(`<span class="rr-img-missing" title="图片不存在或未就绪">🖼 [${escapeHtml(name)}]</span>`);
            continue;
        }
        const store = getBlobStore(row.storageBackend);
        if (!store) {
            urls.push(`<span class="rr-img-missing" title="图暂不可用：存储后端已移除（503）">🖼 [${escapeHtml(name)}]</span>`);
            continue;
        }
        // URL 决策树（spec §7.3）：强制代理 | local | 无 presign 能力（L0 插件兜底）→ 代理路由；
        // s3 + presign → 桶对齐直连。referrerpolicy 已在渲染期预置（Task 3），此处只换 URL。
        const canPresign = !proxyAll && row.storageBackend === 's3' && store.presign !== undefined;
        if (!canPresign) {
            const base = ctx.kind === 'share' ? `/s/${ctx.token}/i/` : `/d/${ctx.docId}/i/`;
            urls.push(`${base}${encodeURIComponent(name)}`);
            continue;
        }
        const cached = presignCache.get(row.id);
        if (cached && cached.bucket === bucket) {
            urls.push(cached.url);
            continue;
        }
        const url = await store.presign('get', row.storageKey, ttl + Math.ceil(bucketMs / 1000));
        if (presignCache.size >= PRESIGN_CACHE_MAX) {
            const first = presignCache.keys().next().value;
            if (first !== undefined) presignCache.delete(first);
        }
        presignCache.set(row.id, { bucket, url });
        urls.push(url);
    }
    // refs 惰性补录（P1-4 content-hash 守卫在 lazyRegisterRefs 内部）：批量单事务
    lazyRegisterRefs(ctx.ownerId, ctx.docId, ctx.contentHash, names);
    // 逐占位符替换（contentHash 前 8 自指防冲突——伪造者的 hash 段不匹配本内容，split 不命中）
    let out = html;
    for (let n = 0; n < names.length; n++) {
        out = out.split(`%%RR:IMG:${ctx.contentHash.slice(0, 8)}:${n}%%`).join(urls[n]);
    }
    return out;
}
```

（Task 4 测试的桶对齐用例须先 `__resetPresignCacheForTest()` + fake timers；FakeS3 的 presign 计数器用于 IMAGE_PROXY_ALL 断言）

- [ ] 绿 → Commit `feat(web): images-resolve 替换阶段——URL 决策树/桶对齐缓存/裂图占位/refs 补录接线（TDD）`

---

### Task 5: page.server 接线 + 集成测试

**Files:** Modify `apps/web/src/routes/s/[token]/+page.server.ts`、`apps/web/src/routes/d/[id]/+page.server.ts`；Test `apps/web/tests/render-pipeline.test.ts`（新建）

- [ ] 失败测试（端到端：正路上传带图 md（initImage+relayImage 建图 → uploadDocument 建 md 引用）→ callShareLoad（照 tiering-view.test.ts 模式）→ 断言 result.html 含 `/s/<token>/i/<name>` 代理 URL 且无 %%RR 残留；callOwner 版同构；裂图 md（引用不存在名）→ html 含 rr-img-missing）

- [ ] 实现——两个 load 的渲染段替换：

/s/[token]/+page.server.ts：
```ts
    const { html: rawHtml, names, contentHash } = await renderMarkdown(content);
    const html = await resolveImages(rawHtml, names, {
        kind: 'share', token: params.token, ownerId: doc.ownerId, docId: doc.id, contentHash
    });
```
（import resolveImages 自 '$server/images-resolve'；其余 load 逻辑不动）

/d/[id]/+page.server.ts：
```ts
    const { html: rawHtml, names, contentHash } = await renderMarkdown(content);
    const html = await resolveImages(rawHtml, names, {
        kind: 'owner', ownerId: locals.user.id, docId: doc.id, contentHash
    });
```

- [ ] 绿 + 既有 share-view/d-view/tiering-view 回归（无图用例不受影响；html 字段形状不变）→ Commit `feat(web): 渲染管线接线 /s/ 与 /d/ load（替换阶段执行，TDD）`

---

### Task 6: MarkdownViewer onerror 兜底 + 裂图样式

**Files:** Modify `apps/web/src/lib/components/MarkdownViewer.svelte`

- [ ] 实现（无单测——Svelte 组件靠 Phase 5 e2e；本任务小且机械）：

script 区追加：

```ts
    // 直连图客户端兜底（spec §7.5）：CDN 失败/签名过期的运行时错误 → 统一 rr-img-missing 占位（带原因 title）
    $effect(() => {
        const root = container;
        if (!root) return;
        const onError = (e: Event): void => {
            const img = e.target as HTMLElement | null;
            if (!(img instanceof HTMLImageElement) || img.dataset.rrImgFallback === '1') return;
            img.dataset.rrImgFallback = '1';
            const span = document.createElement('span');
            span.className = 'rr-img-missing';
            span.title = '图片加载失败：CDN 不可达或链接已过期，刷新页面重试';
            span.textContent = `🖼 [${img.alt || '图片'}]`;
            img.replaceWith(span);
        };
        root.addEventListener('error', onError, true); // error 不冒泡——capture 必需
        return () => root.removeEventListener('error', onError, true);
    });
```

style 区追加（裂图占位——服务器侧与客户端同款观感）：

```css
    .markdown-body :global(.rr-img-missing) {
        display: inline-block;
        padding: 0.6em 1em;
        border: 1px dashed var(--rr-border);
        border-radius: 8px;
        background: var(--rr-code-bg);
        color: var(--rr-text-muted);
        font-size: 0.9em;
    }
```

- [ ] svelte-check 绿 + dev 冒烟（渲染一页带图 md 目检占位/URL）→ Commit `feat(web): 图片 onerror 客户端兜底 + 裂图占位样式`

---

### Task 7: 收尾

- [ ] 全量测试（预期 610 + 新 ~25）+ svelte-check + bridge check + dev 冒烟（进程退净后再全量）→ 最终 Commit（如有收尾）

## Self-Review 记录

1. **Spec 覆盖**：§7.1 两函数分离 ✓ / §7.2 占位符+两段管线+补录接线 ✓ / §7.3 决策树+桶对齐（结果缓存方案）+referrerpolicy（渲染期预置——执行注修正）✓ / §7.4 裂图占位 ✓ / §7.5 onerror ✓ / §12 两 env ✓。Phase 2 遗留的 lazyRegisterRefs 消费者接线本批完成 ✓。
2. **无占位符**：Task 4 的"易读版 useProxy"死代码行在执行注后删除（执行者收敛）；两处执行注均为明确修正指令非含糊占位。
3. **类型一致性**：ResolveCtx 联合与两 load 构造一致；renderMarkdown 返回结构在 Task 3 定义、Task 5 消费、__resetMarkdownCacheForTest 清 Map（value 类型变——签名不变 ✓）。
4. **风险点**：markdown.test.ts 适配量（~15 处 .html 取用）机械但需细心；presignCache 模块级（测试需清——导出 __resetPresignCacheForTest）。
