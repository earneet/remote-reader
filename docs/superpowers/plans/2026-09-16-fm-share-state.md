# FM 分享状态可视化与行操作收敛 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 文件管理器行首私有/共享双样式图标；桌面 ⋯ 下拉 + 移动 ActionSheet 菜单收敛（含新增「复制分享链接」「转为私有」）；ActionSheet/抽屉点击空白关闭；三视图页签位置统一。

**Architecture:** `shared` 布尔由 `share_links` 派生（活跃=未过期）批量进 DTO；新 session 认证端点 `POST/DELETE /api/share/[id]` 提供 get-or-create 与撤销全部；前端新增 `FileStateIcon`/`ActionMenu`/`ShareDialog` 三组件，`RowActions` 收敛为单一 ⋯ 入口，两视图（目录/最近）共用同一菜单项构造。

**Tech Stack:** SvelteKit 2 + Svelte 5 runes、Drizzle + better-sqlite3、vitest（node 运行时）、Playwright 冒烟。

**Spec:** `docs/superpowers/specs/2026-09-16-fm-share-state-design.md`

**测试运行时注意：** 一律 `bun run test ...`（vitest 经 node shebanv 跑，better-sqlite3 原生 addon 在 bun 直跑会挂）。UI 组件无组件级测试基建（repo 现状），服务层/API 严格 TDD，UI 由 svelte-check + Playwright 把关。

---

### Task 1: 服务层 — shares.ts 三个新函数 + ensureShareUrl 过期过滤

**Files:**
- Modify: `apps/web/src/lib/server/shares.ts`（先读 1-6 行确认 import）
- Modify: `apps/web/src/lib/server/documents.ts:196-205`（ensureShareUrl）
- Test: `apps/web/tests/shares.test.ts`（先读现有结构，仿其建用户/文档方式）

- [ ] **Step 1: 读 `apps/web/tests/shares.test.ts` 与 `apps/web/tests/helpers.ts`，确认既有建用户/建文档/插 share_links 的辅助方式**

- [ ] **Step 2: 写失败测试（追加到 shares.test.ts，命名与风格随既有）**

```ts
// —— spec 2026-09-16 §3.1：getOrCreateShareUrl / revokeAllShares / sharedDocIds ——
describe('getOrCreateShareUrl', () => {
    it('无链接时新建并返回 /s/ 绝对 URL', async () => {
        // 前置：owner + file 文档（复用既有 helper）
        const url = await getOrCreateShareUrl(owner.id, doc.id);
        expect(url).toMatch(/\/s\/[A-Za-z0-9_-]{22}$/);
        expect(listSharesByOwner(owner.id).length).toBe(1);
    });
    it('已有活跃链接时复用同一 URL，不新增行', async () => {
        const first = await getOrCreateShareUrl(owner.id, doc.id);
        const second = await getOrCreateShareUrl(owner.id, doc.id);
        expect(second).toBe(first);
        expect(listSharesByOwner(owner.id).length).toBe(1);
    });
    it('仅有过期链接时新建（旧链接不返回）', async () => {
        const first = await getOrCreateShareUrl(owner.id, doc.id);
        // 手工把唯一链接置为过期（直接 db.update share_links）
        db.update(schema.shareLinks).set({ expiresAt: Date.now() - 1000 })
            .where(eq(schema.shareLinks.token, first.split('/s/')[1])).run();
        const second = await getOrCreateShareUrl(owner.id, doc.id);
        expect(second).not.toBe(first);
        expect(getDocumentIdByShareToken(first.split('/s/')[1])).toBeNull();
    });
    it('非 owner 或不存在 → null', async () => {
        expect(await getOrCreateShareUrl(otherOwner.id, doc.id)).toBeNull();
        expect(await getOrCreateShareUrl(owner.id, 'nope')).toBeNull();
    });
    it('folder → null', async () => {
        expect(await getOrCreateShareUrl(owner.id, folder.id)).toBeNull();
    });
});

describe('revokeAllShares', () => {
    it('删除该文档全部链接（多条），返回删除数', async () => {
        await getOrCreateShareUrl(owner.id, doc.id);
        await createShareLink(doc.id); // 第二条
        const n = revokeAllShares(owner.id, doc.id);
        expect(n).toBe(2);
        expect(sharedDocIds(owner.id, [doc.id]).has(doc.id)).toBe(false);
    });
    it('非 owner → 0 且不删', async () => {
        await getOrCreateShareUrl(owner.id, doc.id);
        expect(revokeAllShares(otherOwner.id, doc.id)).toBe(0);
        expect(sharedDocIds(owner.id, [doc.id]).has(doc.id)).toBe(true);
    });
    it('无链接幂等 → 0', () => {
        expect(revokeAllShares(owner.id, doc.id)).toBe(0);
    });
});

describe('sharedDocIds', () => {
    it('批量返回有活跃链接的文件 id；过期不算；空入参空集', async () => {
        // sharedDoc = 有链接；expiredDoc = 只有过期链接；plainDoc = 无链接
        const s = sharedDocIds(owner.id, [sharedDoc.id, expiredDoc.id, plainDoc.id, folder.id]);
        expect(s.has(sharedDoc.id)).toBe(true);
        expect(s.has(expiredDoc.id)).toBe(false);
        expect(s.has(plainDoc.id)).toBe(false);
        expect(sharedDocIds(owner.id, [])).toEqual(new Set());
    });
});

describe('ensureShareUrl 过期过滤回归（spec §3.1）', () => {
    it('同内容重传若唯一链接已过期 → 返回新链接', async () => {
        const r1 = await uploadDocument(owner.id, 'a.md', '# x', []);
        db.update(schema.shareLinks).set({ expiresAt: Date.now() - 1 }).run();
        const r2 = await uploadDocument(owner.id, 'a.md', '# x', []);
        expect(r2.url).not.toBe(r1.url);
    });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun run test apps/web/tests/shares.test.ts`
Expected: FAIL（`getOrCreateShareUrl` 等未导出）

- [ ] **Step 4: 实现 shares.ts（新增，import 区补 `isNull, gt, inArray, or` 到 drizzle-orm 导入）**

```ts
// —— spec 2026-09-16 §3.1 ——
// 活跃链接判定单源：未过期（expires_at IS NULL OR > now）；当前生产者恒 NULL，过滤为正确性预留
const activeShareCond = () => or(
    isNull(schema.shareLinks.expiresAt),
    gt(schema.shareLinks.expiresAt, Date.now())
);

function activeShareOf(documentId: string): { token: string } | null {
    return db.select({ token: schema.shareLinks.token })
        .from(schema.shareLinks)
        .where(and(eq(schema.shareLinks.documentId, documentId), activeShareCond()))
        .orderBy(desc(schema.shareLinks.createdAt))
        .get() ?? null;
}

// 批量派生：哪些文档存在活跃链接（owner join 防御性过滤，入参本就 owner 作用域）
export function sharedDocIds(ownerId: string, docIds: string[]): Set<string> {
    if (docIds.length === 0) return new Set();
    const rows = db.select({ documentId: schema.shareLinks.documentId })
        .from(schema.shareLinks)
        .innerJoin(schema.documents, eq(schema.shareLinks.documentId, schema.documents.id))
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            inArray(schema.shareLinks.documentId, docIds),
            activeShareCond()
        ))
        .all();
    return new Set(rows.map((r) => r.documentId));
}

// FM 复制分享链接：get-or-create；非 owner/不存在/folder → null（404 口径由路由层转）
export async function getOrCreateShareUrl(ownerId: string, documentId: string): Promise<string | null> {
    const doc = db.select({ type: schema.documents.type })
        .from(schema.documents)
        .where(and(eq(schema.documents.id, documentId), eq(schema.documents.ownerId, ownerId)))
        .get();
    if (!doc || doc.type !== 'file') return null;
    const active = activeShareOf(documentId);
    if (active) return `${getBaseUrl()}/s/${active.token}`;
    const { url } = await createShareLink(documentId);
    return url;
}

// 转为私有：删该文档全部链接（owner 校验后按 documentId 全删——share_links 无跨 owner 可能）
export function revokeAllShares(ownerId: string, documentId: string): number {
    const doc = db.select({ id: schema.documents.id })
        .from(schema.documents)
        .where(and(eq(schema.documents.id, documentId), eq(schema.documents.ownerId, ownerId)))
        .get();
    if (!doc) return 0;
    return db.delete(schema.shareLinks)
        .where(eq(schema.shareLinks.documentId, documentId))
        .run().changes;
}
```

`documents.ts` 的 `ensureShareUrl` 改为复用（import 区从 `./shares` 增补 `activeShareOf`）：

```ts
async function ensureShareUrl(documentId: string): Promise<string> {
    const active = activeShareOf(documentId);
    if (active) return `${getBaseUrl()}/s/${active.token}`;
    const { url } = await createShareLink(documentId);
    return url;
}
```

（`activeShareOf` 需在 shares.ts export）

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run test apps/web/tests/shares.test.ts`
Expected: PASS 全绿

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/lib/server/shares.ts apps/web/src/lib/server/documents.ts apps/web/tests/shares.test.ts
git commit -m "feat(web): 分享服务层——getOrCreateShareUrl/revokeAllShares/sharedDocIds 派生 + ensureShareUrl 过期过滤"
```

---

### Task 2: DTO 契约扩展 — RecentDoc.shared + load/api 填充

**Files:**
- Modify: `apps/web/src/lib/shared/recent.ts:8-19`（RecentDoc 加 `shared: boolean`）
- Modify: `apps/web/src/lib/server/documents.ts:21-33`（toDocDTO 第二参）
- Modify: `apps/web/src/routes/+page.server.ts:18-44`（load 三视图填充）
- Modify: `apps/web/src/routes/api/recent/+server.ts:36-38`（填充）
- Test: 既有 recent/load 相关测试文件（跑全量看破口，按破口补断言）

- [ ] **Step 1: recent.ts 的 RecentDoc 类型加字段（tags 前一行）**

```ts
    storageTier: 'hot' | 'cold';
    /** 是否存在活跃分享链接（spec 2026-09-16 §3.2；folder 恒 false，load/端点派生填充） */
    shared: boolean;
    tags: { id: string; name: string }[];
```

- [ ] **Step 2: toDocDTO 加默认参数**

```ts
export function toDocDTO(r: DocumentRow, shared = false): DocDTO {
    return {
        id: r.id,
        parentId: r.parentId,
        name: r.name,
        type: r.type,
        sizeBytes: r.sizeBytes,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        ownerViewedAt: r.ownerViewedAt,
        storageTier: r.storageTier,
        shared
    };
}
```

- [ ] **Step 3: +page.server.ts load 填充（import 增 `sharedDocIds` 自 `$server/shares`）**

recent/viewed 分支：

```ts
        const rows = recentFiles(locals.user.id, view === 'viewed' ? 'viewed' : 'updated', null, RECENT_PAGE_SIZE);
        const fileIds = rows.filter((r) => r.type === 'file').map((r) => r.id);
        const tagsByDoc = listTagsForDocs(fileIds, locals.user.id);
        const sharedIds = sharedDocIds(locals.user.id, fileIds);
        const list = rows.map((r) => ({ ...toDocDTO(r, sharedIds.has(r.id)), tags: tagsByDoc.get(r.id) ?? [] }));
```

dir 分支：

```ts
    const rows = listChildren(locals.user.id, parentId);
    const fileIds = rows.filter((r) => r.type === 'file').map((r) => r.id);
    const tagsByDoc = listTagsForDocs(fileIds, locals.user.id);
    const sharedIds = sharedDocIds(locals.user.id, fileIds);
    const children = rows.map((r) => toDocDTO(r, sharedIds.has(r.id)));
```

- [ ] **Step 4: /api/recent 填充（同型）**

```ts
    const rows = recentFiles(locals.user.id, sort, cursor, limit);
    const fileIds = rows.filter((r) => r.type === 'file').map((r) => r.id);
    const tagsByDoc = listTagsForDocs(fileIds, locals.user.id);
    const sharedIds = sharedDocIds(locals.user.id, fileIds);
    return json({ items: rows.map((r) => ({ ...toDocDTO(r, sharedIds.has(r.id)), tags: tagsByDoc.get(r.id) ?? [] })) });
```

- [ ] **Step 5: 跑全量测试定位类型破口并补断言**

Run: `bun run test`
Expected: 既有 toDocDTO/RecentDoc 相关断言若失败按新字段修正；在 recent 视图既有测试补一条「有链接的文档 shared=true、无链接 false、folder false」

- [ ] **Step 6: svelte-check**

Run: `bun --filter remote-reader-web check`
Expected: 0 error（RecentList 等消费方未用 shared 前不破）

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/lib/shared/recent.ts apps/web/src/lib/server/documents.ts apps/web/src/routes/+page.server.ts apps/web/src/routes/api/recent/+server.ts apps/web/tests
git commit -m "feat(web): RecentDoc/DocDTO 契约扩展 shared 派生字段——load 与 /api/recent 批量填充"
```

---

### Task 3: API 端点 — /api/share/[id] POST/DELETE

**Files:**
- Create: `apps/web/src/routes/api/share/[id]/+server.ts`
- Test: `apps/web/tests/share-actions.test.ts`（新建；先读 `apps/web/tests` 里既有端点测试如 view-beacon 的调用方式并仿之）

- [ ] **Step 1: 读既有端点测试的 handler 调用模式（locals/params 造法）**

- [ ] **Step 2: 写失败测试（share-actions.test.ts，仿既有模式）**

```ts
// —— spec 2026-09-16 §4：session 认证 + owner 校验 + 404 不泄漏存在性 ——
describe('POST /api/share/[id]', () => {
    it('未登录 401', async () => {
        const res = await POST({ locals: { user: null }, params: { id: 'x' } } as never);
        expect(res.status).toBe(401);
    });
    it('非 owner / 不存在 / folder → 404', async () => {
        expect((await POST({ locals: { user: { id: other.id } }, params: { id: doc.id } } as never)).status).toBe(404);
        expect((await POST({ locals: { user: { id: owner.id } }, params: { id: 'nope' } } as never)).status).toBe(404);
        expect((await POST({ locals: { user: { id: owner.id } }, params: { id: folder.id } } as never)).status).toBe(404);
    });
    it('owner file → 200 { url }，重复调用同 URL（get-or-create）', async () => {
        const r1 = await POST({ locals: { user: { id: owner.id } }, params: { id: doc.id } } as never);
        expect(r1.status).toBe(200);
        const u1 = await r1.json();
        expect(u1.url).toMatch(/\/s\//);
        const r2 = await POST({ locals: { user: { id: owner.id } }, params: { id: doc.id } } as never);
        expect((await r2.json()).url).toBe(u1.url);
    });
});
describe('DELETE /api/share/[id]', () => {
    it('未登录 401；非 owner 404；owner 幂等 200 {ok:true} 且链接失效', async () => {
        expect((await DELETE({ locals: { user: null }, params: { id: doc.id } } as never)).status).toBe(401);
        await getOrCreateShareUrl(owner.id, doc.id);
        expect((await DELETE({ locals: { user: { id: other.id } }, params: { id: doc.id } } as never)).status).toBe(404);
        const res = await DELETE({ locals: { user: { id: owner.id } }, params: { id: doc.id } } as never);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ ok: true });
        expect(sharedDocIds(owner.id, [doc.id]).size).toBe(0);
        expect((await DELETE({ locals: { user: { id: owner.id } }, params: { id: doc.id } } as never)).status).toBe(200); // 幂等
    });
});
```

（`locals.user` 形状按既有测试的真实 User 对象调整——若既有测试直接传完整 user 则照抄）

- [ ] **Step 3: 跑测试确认失败（模块不存在）**

Run: `bun run test apps/web/tests/share-actions.test.ts`
Expected: FAIL

- [ ] **Step 4: 实现端点**

```ts
import { error, json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getOrCreateShareUrl, revokeAllShares } from '$server/shares';

// FM 行内分享操作（spec 2026-09-16 §4）：session 认证 + owner 校验，404 不泄漏存在性（同 /api/view 口径）。
// POST = get-or-create 活跃链接（与上传幂等「链接长期稳定」同语义）；DELETE = 转为私有（撤销全部链接，幂等）。
export const POST: RequestHandler = async ({ locals, params }) => {
    if (!locals.user) error(401, 'unauthorized');
    const url = await getOrCreateShareUrl(locals.user.id, params.id);
    if (!url) error(404, 'not found');
    return json({ url });
};

export const DELETE: RequestHandler = async ({ locals, params }) => {
    if (!locals.user) error(401, 'unauthorized');
    revokeAllShares(locals.user.id, params.id);
    return json({ ok: true });
};
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run test apps/web/tests/share-actions.test.ts`
Expected: PASS

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/routes/api/share apps/web/tests/share-actions.test.ts
git commit -m "feat(web): /api/share/[id] 端点——POST get-or-create 分享链接 / DELETE 转为私有"
```

---

### Task 4: FileStateIcon 组件

**Files:**
- Create: `apps/web/src/lib/components/FileStateIcon.svelte`

纯展示组件（repo 无组件测试基建），svelte-check + Playwright 把关。

- [ ] **Step 1: 写组件**

```svelte
<script lang="ts">
    // 行首文档状态图标（spec 2026-09-16 §5.1）：文件夹 / 私有文件 / 共享文件（右下链接角标）三形态。
    // currentColor 描边随主题/上下文；共享角标语义色走 --rr-link（theme.css 单源，禁写死色值）
    let {
        type,
        shared = false
    }: {
        type: 'file' | 'folder';
        shared?: boolean;
    } = $props();

    const label = $derived(type === 'file' ? (shared ? '已共享' : '私有') : null);
</script>

<span class="doc-icon" aria-label={label ?? undefined} title={label ?? undefined}>
    {#if type === 'folder'}
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
            stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">
            <path d="M1.75 3h4.2a1 1 0 0 1 .78.37l1.1 1.38a.4.4 0 0 0 .31.15h6.11a.75.75 0 0 1 .75.75v6.85a.75.75 0 0 1-.75.75H1.75a.75.75 0 0 1-.75-.75V3.75A.75.75 0 0 1 1.75 3Z"></path>
        </svg>
    {:else}
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
            stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 2h8a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75H4a.75.75 0 0 1-.75-.75V2.75A.75.75 0 0 1 4 2Z"></path>
            <path stroke-linecap="round" stroke-width="1.1" d="M5.75 6h4.5M5.75 8.5h4.5"></path>
            {#if shared}
                <!-- 链接角标：卡底圆 + 双环链扣，--rr-link 语义色 -->
                <circle cx="11.9" cy="11.9" r="3.7" fill="var(--rr-card-bg)" stroke="var(--rr-link)" stroke-width="1.2"></circle>
                <circle cx="11.05" cy="12.75" r="1.15" stroke="var(--rr-link)" stroke-width="1"></circle>
                <circle cx="12.75" cy="11.05" r="1.15" stroke="var(--rr-link)" stroke-width="1"></circle>
            {:else}
                <path stroke-linecap="round" stroke-width="1.1" d="M5.75 11h3"></path>
            {/if}
        </svg>
    {/if}
</span>

<style>
    .doc-icon { display: inline-flex; flex-shrink: 0; vertical-align: -0.15rem; }
</style>
```

- [ ] **Step 2: svelte-check**

Run: `bun --filter remote-reader-web check`
Expected: 0 error

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/lib/components/FileStateIcon.svelte
git commit -m "feat(web): FileStateIcon 行首私有/共享双样式图标组件"
```

---

### Task 5: RowActions 收敛 + ActionMenu 桌面下拉

**Files:**
- Rewrite: `apps/web/src/lib/components/RowActions.svelte`
- Create: `apps/web/src/lib/components/ActionMenu.svelte`

- [ ] **Step 1: 重写 RowActions（单一 ⋯ 双端可见；moving 桌面 hint+取消保留、移动端 ⋯ 保留）**

```svelte
<script lang="ts">
    // 文档行操作入口（目录视图与 RecentList 共用，spec 2026-09-16 §5.2）：
    // 单一 ⋯ 按钮双端可见——桌面开 ActionMenu 下拉、移动开 ActionSheet 底部菜单，父级按 isMobile 路由。
    // onMore 把按钮元素回传作下拉锚点。移动进行中：桌面在 ⋯ 前显示提示+取消（移动端取消走抽屉内提示）。
    let {
        moving = false,
        onMore,
        onCancelMove
    }: {
        moving?: boolean;
        onMore: (anchor: HTMLElement) => void;
        onCancelMove: () => void;
    } = $props();
</script>

<span class="actions">
    {#if moving}
        <span class="hint desktop-only">← 左树选目标</span>
        <button type="button" class="btn sm desktop-only" onclick={onCancelMove}>取消</button>
    {/if}
    <button type="button" class="icon-btn more-btn" aria-label="更多操作" aria-haspopup="menu"
        onclick={(e) => onMore(e.currentTarget)}>
        <svg viewBox="0 0 16 16" width="18" height="18" fill="currentColor" aria-hidden="true"><path d="M8 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3ZM1.5 9a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Zm13 0a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z"></path></svg>
    </button>
</span>

<style>
    .actions { display: inline-flex; align-items: center; gap: 0.2rem; flex-shrink: 0; }
    .more-btn { padding: 0.45rem 0.5rem; }
    .hint { color: var(--rr-success); font-size: 0.85em; }
</style>
```

- [ ] **Step 2: 写 ActionMenu**

```svelte
<script lang="ts">
    // 桌面 ⋯ 下拉菜单（spec 2026-09-16 §5.3）：fixed 定位锚定触发按钮（.fm-right 是 overflow-y:auto
    // 滚动容器，absolute 会被裁剪）；外点/Esc/滚动关闭，打开聚焦首项，关闭归还焦点。
    // 菜单项与 ActionSheet 同构（{key,label,danger}），不推 history（桌面无返回键场景）。
    let {
        label = '操作',
        actions,
        onSelect
    }: {
        label?: string;
        actions: { key: string; label: string; danger?: boolean }[];
        onSelect: (key: string) => void;
    } = $props();

    let menu = $state<HTMLDivElement | null>(null);
    let anchor = $state<HTMLElement | null>(null);
    let open = $state(false);
    let pos = $state({ top: '0px', left: '0px' });

    export function toggle(anchorEl: HTMLElement): void {
        if (open && anchor === anchorEl) { hide(); return; }
        anchor = anchorEl;
        const r = anchorEl.getBoundingClientRect();
        // 右对齐锚点、下弹；视口下缘放不下则上翻（高度按项数估算，菜单 ≤6 项够用）
        const estH = actions.length * 2.3 + 0.8; // rem
        const below = r.bottom + 4;
        const flipUp = below + estH * 16 > window.innerHeight;
        const top = flipUp ? Math.max(8, r.top - 4 - estH * 16) : below;
        pos = { top: `${top}px`, left: `${Math.max(8, r.right)}px` };
        open = true;
        requestAnimationFrame(() => menu?.querySelector<HTMLButtonElement>('button')?.focus());
    }

    export function hide(): void {
        if (!open) return;
        open = false;
        anchor?.focus();
    }

    function pick(key: string): void {
        open = false;
        onSelect(key);
    }

    // 外点（锚点自身除外——再点是 toggle 关）+ Esc + 任何滚动 → 关
    $effect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            const t = e.target as Node;
            if (menu && !menu.contains(t) && anchor && !anchor.contains(t)) hide();
        };
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') { e.stopPropagation(); hide(); }
        };
        const onScroll = () => hide();
        document.addEventListener('click', onDoc, true);
        document.addEventListener('keydown', onKey, true);
        document.addEventListener('scroll', onScroll, true);
        return () => {
            document.removeEventListener('click', onDoc, true);
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('scroll', onScroll, true);
        };
    });
</script>

{#if open}
    <div class="menu" role="group" aria-label={label} bind:this={menu}
        style={`top:${pos.top};left:${pos.left}`}>
        {#each actions as a (a.key)}
            <button type="button" class="menu-item" class:danger={a.danger} onclick={() => pick(a.key)}>
                {a.label}
            </button>
        {/each}
    </div>
{/if}

<style>
    .menu {
        position: fixed; z-index: 100;
        transform: translateX(-100%); /* left=锚点右缘，整体左移自身宽 → 右对齐锚点 */
        min-width: 11rem; padding: 0.3rem;
        background: var(--rr-card-bg); border: 1px solid var(--rr-border); border-radius: 8px;
        box-shadow: 0 4px 14px var(--rr-scrim);
        display: flex; flex-direction: column;
    }
    .menu-item {
        border: none; background: none; cursor: pointer; text-align: left;
        padding: 0.45rem 0.7rem; border-radius: 6px; font-size: 0.92rem;
        color: var(--rr-text);
    }
    .menu-item:hover, .menu-item:focus-visible { background: var(--rr-hover-bg); outline: none; }
    .menu-item.danger { color: var(--rr-danger); }
</style>
```

- [ ] **Step 3: svelte-check（此时 +page/RecentList 还传旧 props——本 Task 先不接，下一 Task 接入后一起过 check；此处只确认两新文件语法）**

Run: `bun --filter remote-reader-web check`
Expected: RowActions 消费方报 props 不匹配属预期（下一 Task 消除）；若无报错更好

- [ ] **Step 4: 提交（与 Task 6/7 合并提交亦可，按原子性拆分）**

```bash
git add apps/web/src/lib/components/RowActions.svelte apps/web/src/lib/components/ActionMenu.svelte
git commit -m "feat(web): RowActions 收敛单一 ⋯ 入口 + ActionMenu 桌面下拉菜单组件"
```

---

### Task 6: ActionSheet backdrop 关闭 + ShareDialog 组件

**Files:**
- Modify: `apps/web/src/lib/components/ActionSheet.svelte:59-64`（dialog 加 onclick）
- Create: `apps/web/src/lib/components/ShareDialog.svelte`

- [ ] **Step 1: ActionSheet 的 `<dialog>` 增 backdrop 点击关闭（走既有 hide→onclose 编排，返回键语义不变）**

```svelte
<dialog
    class="sheet"
    aria-label={label}
    bind:this={dialog}
    onclose={onDialogClose}
    onclick={(e) => { if (e.target === dialog) hide(); }}
>
```

- [ ] **Step 2: 写 ShareDialog**

```svelte
<script lang="ts">
    // 分享链接浮层（spec 2026-09-16 §5.5）：居中 <dialog>，只读 URL + 复制（clipboard API +
    // execCommand 降级 + ✓ 反馈；非安全上下文降级失败仍可手动选中复制）。
    // Esc/backdrop/返回键关闭；滚动锁 + overlay-history 编排同 ActionSheet。
    import { lockBodyScroll, unlockBodyScroll } from '$lib/shared/body-scroll';
    import { createOverlayHistory } from '$lib/shared/overlay-history';

    let dialog = $state<HTMLDialogElement | null>(null);
    let url = $state('');
    let copied = $state(false);
    let copyFailed = $state(false);
    const overlayHistory = createOverlayHistory();

    export function show(u: string): void {
        url = u; copied = false; copyFailed = false;
        dialog?.showModal();
        lockBodyScroll();
        overlayHistory.push();
        // 聚焦并全选：直接 Ctrl+C / 长按复制可用
        requestAnimationFrame(() => {
            const input = dialog?.querySelector<HTMLInputElement>('input.url');
            input?.focus();
            input?.select();
        });
    }

    export function hide(): void { dialog?.close(); }

    async function onDialogClose(): Promise<void> {
        unlockBodyScroll();
        await overlayHistory.consume();
    }

    async function copy(): Promise<void> {
        try {
            await navigator.clipboard.writeText(url);
            copied = true; copyFailed = false;
        } catch {
            // 降级：非安全上下文（HTTP）/权限拒绝 → 选中后 execCommand
            const input = dialog?.querySelector<HTMLInputElement>('input.url');
            let ok = false;
            if (input) {
                input.focus(); input.select();
                ok = document.execCommand('copy');
            }
            copied = ok; copyFailed = !ok;
        }
        if (copied) setTimeout(() => { copied = false; }, 2000);
    }

    // 系统返回键 = 关浮层而非真实后退（同 ActionSheet 编排）
    $effect(() => {
        const onPop = () => {
            if (dialog?.open) {
                overlayHistory.markConsumedByPop();
                dialog.close();
            }
        };
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    });
</script>

<dialog class="share" aria-label="分享链接" bind:this={dialog} onclose={onDialogClose}
    onclick={(e) => { if (e.target === dialog) hide(); }}>
    <h2>分享链接</h2>
    <p class="hint">凭此链接免登录查看文档；转为私有后立即失效。</p>
    <input class="url" value={url} readonly>
    <div class="row">
        <button type="button" class="btn primary" onclick={() => void copy()}>
            {copied ? '已复制 ✓' : '复制链接'}
        </button>
        <button type="button" class="btn" onclick={hide}>关闭</button>
        {#if copyFailed}<span class="error">复制失败，请手动选中上方内容复制</span>{/if}
    </div>
</dialog>

<style>
    .share {
        margin: auto; /* 居中 */
        width: min(92vw, 34rem); box-sizing: border-box;
        border: 1px solid var(--rr-border); border-radius: 10px;
        padding: 1.25rem 1.25rem 1rem;
        background: var(--rr-card-bg); color: var(--rr-text);
        font-family: system-ui, sans-serif;
    }
    .share::backdrop { background: var(--rr-scrim); }
    h2 { margin: 0 0 0.4rem; font-size: 1.1rem; }
    .hint { margin: 0 0 0.8rem; color: var(--rr-text); font-size: 0.85rem; opacity: 0.75; }
    .url {
        width: 100%; box-sizing: border-box; padding: 0.45rem 0.6rem;
        border: 1px solid var(--rr-border); border-radius: 6px;
        background: var(--rr-input-bg); color: var(--rr-text);
        font-size: 0.85rem; font-family: ui-monospace, monospace;
    }
    .row { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.8rem; }
    .error { color: var(--rr-danger); font-size: 0.8rem; }
</style>
```

- [ ] **Step 3: 提交**

```bash
git add apps/web/src/lib/components/ActionSheet.svelte apps/web/src/lib/components/ShareDialog.svelte
git commit -m "feat(web): ActionSheet 点击空白关闭 + ShareDialog 分享链接浮层（复制+降级）"
```

---

### Task 7: +page.svelte 接入（目录视图）

**Files:**
- Modify: `apps/web/src/routes/+page.svelte`（行模板/菜单路由/新动作/页签重排/抽屉 backdrop）

- [ ] **Step 1: script 区改动**

imports 增：`FileStateIcon`、`ActionMenu`、`ShareDialog`（均 `$components`）。

state 增/改：

```ts
    let actionMenu = $state<ActionMenu | null>(null);
    let shareDialog = $state<ShareDialog | null>(null);
    // 菜单上下文（sheet 与桌面下拉共用）：id + type + shared（构造条件菜单项）
    let menuCtx = $state<{ id: string; type: string; shared: boolean } | null>(null);
```

删除 `sheetItem` 与旧 `openSheet`/`onSheetAction`，替换为：

```ts
    // 菜单项构造（spec §5.6，两端同构）：file 多出 标签/分享/转私有（仅 shared 时）
    function rowActions(item: { type: string; shared: boolean }): { key: string; label: string; danger?: boolean }[] {
        return [
            { key: 'rename', label: '重命名' },
            ...(item.type === 'file' ? [{ key: 'tags', label: '编辑标签' }] : []),
            { key: 'move', label: '移动到…' },
            ...(item.type === 'file' ? [
                { key: 'share', label: '复制分享链接' },
                ...(item.shared ? [{ key: 'unshare', label: '转为私有', danger: true }] : [])
            ] : []),
            { key: 'delete', label: '删除', danger: true }
        ];
    }

    // ⋯ 入口路由：移动端底部 sheet，桌面锚定下拉
    function openRowMenu(anchor: HTMLElement, id: string, type: string, shared: boolean): void {
        menuCtx = { id, type, shared };
        if (isMobile) sheet?.show();
        else actionMenu?.toggle(anchor);
    }

    function onRowAction(key: string): void {
        const it = menuCtx;
        if (!it) return;
        menuCtx = null;
        if (key === 'rename') startRename(it.id);
        else if (key === 'tags') { taggingId = it.id; tagInput = ''; tagError = null; }
        else if (key === 'move') startMove(it.id);
        else if (key === 'share') void doShare(it.id);
        else if (key === 'unshare') void doUnshare(it.id);
        else if (key === 'delete') void doDelete(it.id, it.type);
    }

    // 复制分享链接（get-or-create）：成功后刷新（私有→共享翻转）再弹浮层
    async function doShare(id: string): Promise<void> {
        busyId = id;
        try {
            const r = await fetch(`/api/share/${encodeURIComponent(id)}`, { method: 'POST' });
            if (!r.ok) throw new Error(String(r.status));
            const data = await r.json() as { url: string };
            await invalidateAll();
            await recentRef?.reSync();
            shareDialog?.show(data.url);
        } catch {
            actionError = '获取分享链接失败，请重试';
        } finally {
            busyId = null;
        }
    }

    // 转为私有：撤销该文档全部分享链接（幂等，404=文档已不在也算完成）
    async function doUnshare(id: string): Promise<void> {
        if (!confirm('转为私有后，该文档的所有分享链接立即失效（已发出的链接将无法再打开），且不可恢复。继续？')) return;
        busyId = id;
        try {
            const r = await fetch(`/api/share/${encodeURIComponent(id)}`, { method: 'DELETE' });
            if (!r.ok && r.status !== 404) throw new Error(String(r.status));
            actionError = null;
            await invalidateAll();
            await recentRef?.reSync();
        } catch {
            actionError = '转为私有失败，请重试';
        } finally {
            busyId = null;
        }
    }
```

（先确认 `actionError` 在模板有渲染位；若无，在 `.fm-head` 后加 `{#if actionError}<p class="error">{actionError} <button class="link" onclick={() => (actionError = null)}>关闭</button></p>{/if}`）

- [ ] **Step 2: 行模板改动（dir 视图 each 内）**

```svelte
<span class="name">
    {#if item.type === 'folder'}
        <a href="/?dir={item.id}"><FileStateIcon type="folder" /> {item.name}</a>
    {:else}
        <a href="/d/{item.id}"><FileStateIcon type="file" shared={item.shared} /> {item.name}</a>
        {#if item.storageTier === 'cold'}<span class="chip-static cold-chip">☁️ 已归档</span>{/if}
    {/if}
    {#if item.type !== 'folder' && item.sizeBytes != null}
        <span class="size">{item.sizeBytes} B</span>
    {/if}
</span>
```

`.doc-tags` 内删 `{:else}🏷按钮{/if}` 分支（保留 chips + InlineTagForm 条件渲染）：

```svelte
<span class="doc-tags">
    {#each (data.tagsByDoc.get(item.id) ?? []) as tg (tg.id)}
        <span class="chip-static">{tg.name}</span>
    {/each}
    {#if taggingId === item.id}
        <InlineTagForm ...原样... />
    {/if}
</span>
```

RowActions 换新 props：

```svelte
<RowActions
    moving={movingId === item.id}
    onMore={(btn) => openRowMenu(btn, item.id, item.type, item.shared)}
    onCancelMove={() => (movingId = null)}
/>
```

- [ ] **Step 3: 实例区（文件尾部 ActionSheet 旁）**

```svelte
<ActionSheet
    bind:this={sheet}
    label="文档操作"
    actions={menuCtx ? rowActions(menuCtx) : []}
    onSelect={onRowAction}
/>
<ActionMenu
    bind:this={actionMenu}
    label="文档操作"
    actions={menuCtx ? rowActions(menuCtx) : []}
    onSelect={onRowAction}
/>
<ShareDialog bind:this={shareDialog} />
```

- [ ] **Step 4: 抽屉 backdrop 关闭（drawer dialog 加 onclick）**

```svelte
<dialog class="drawer" bind:this={drawerRef} onclose={onDrawerClose} aria-label="目录导航"
    onclick={(e) => { if (e.target === drawerRef) void closeDrawer(); }}>
```

- [ ] **Step 5: 页签重排（spec §5.8）——`.fm-head` 内把桌面新建表单移入右簇、segmented 恒末位**

```
<div class="fm-head">
    <div class="fm-title">…汉堡/面包屑/h1（不动）…</div>
    <div class="fm-title">
        {#if view === 'dir'}
            <form class="create-folder desktop-only" …桌面新建表单（原第三个子元素，原样内移）…></form>
            <button …＋ 文件夹 mobile-only（原位，仍 segmented 前）…>＋ 文件夹</button>
        {/if}
        <div class="segmented" …>…三个 seg-btn（不动）…</div>
    </div>
    …mobile showCreate 表单与 createError 原样保留在外层…
</div>
```

- [ ] **Step 6: svelte-check + 跑全量**

Run: `bun --filter remote-reader-web check && bun run test`
Expected: 0 error；测试全绿（RecentList 尚未接入，其 RowActions 旧 props 会报错——若报错则本步先在 RecentList 同步做 Task 8 的接入，两 Task 合并提交）

- [ ] **Step 7: 提交**

```bash
git add apps/web/src/routes/+page.svelte
git commit -m "feat(web): FM 目录视图接入——双样式图标/⋯ 菜单路由/分享与转私有/抽屉空白关闭/页签对齐"
```

---

### Task 8: RecentList 接入（最近文档/最近浏览视图）

**Files:**
- Modify: `apps/web/src/lib/components/RecentList.svelte`（先读 1-29 行 props 与 274-301 CSS）

- [ ] **Step 1: props 增 `isMobile: boolean`（+page 已有该状态，传入）；imports 增 FileStateIcon/ActionMenu/ShareDialog**

- [ ] **Step 2: state/逻辑改动（与 +page 同型）**

```ts
    let actionMenu = $state<ActionMenu | null>(null);
    let shareDialog = $state<ShareDialog | null>(null);
    // 菜单上下文：RecentList 全按行数据构造（type 一并入，防未来含 folder）
    let menuCtx = $state<{ id: string; type: string; shared: boolean } | null>(null);
```

`rowActions(item)` 同 +page 版本（提为组件内函数；两处重复 10 行属可接受内聚——如实现时发现更优提取位（如 `$lib/shared/row-menu.ts` 纯函数 + 单测），按提取做并补 5 用例单测）。

`openSheet(id)`/`onSheetAction(key)` 替换为 `openRowMenu(anchor, item)` + `onRowAction(key)`（同 +page 逻辑，错误走 `deleteError` 横幅通道）；`doShare(item)`/`doUnshare(item)`：

```ts
    async function doShare(item: RecentDoc): Promise<void> {
        busyId = item.id;
        try {
            const r = await fetch(`/api/share/${encodeURIComponent(item.id)}`, { method: 'POST' });
            if (!r.ok) throw new Error(String(r.status));
            const data = await r.json() as { url: string };
            await invalidateAll(); // 刷页面级数据（左树计数等）
            await reSync();        // 行内 shared 翻转
            shareDialog?.show(data.url);
        } catch {
            deleteError = '获取分享链接失败，请重试';
        } finally {
            busyId = null;
        }
    }

    async function doUnshare(item: RecentDoc): Promise<void> {
        if (!confirm('转为私有后，该文档的所有分享链接立即失效（已发出的链接将无法再打开），且不可恢复。继续？')) return;
        busyId = item.id;
        try {
            const r = await fetch(`/api/share/${encodeURIComponent(item.id)}`, { method: 'DELETE' });
            if (!r.ok && r.status !== 404) throw new Error(String(r.status));
            deleteError = null;
            await invalidateAll();
            await reSync();
        } catch {
            deleteError = '转为私有失败，请重试';
        } finally {
            busyId = null;
        }
    }
```

- [ ] **Step 3: 行模板：`<a href="/d/{item.id}"><FileStateIcon type={item.type} shared={item.shared} /> {item.name}</a>`；删 🏷 else 分支；RowActions 换 `onMore={(btn) => openRowMenu(btn, item)}`**

- [ ] **Step 4: 实例区加 ActionMenu/ShareDialog（ActionSheet 的 actions 换 `menuCtx ? rowActions(menuCtx) : []`）；+page 的 RecentList 调用处传 `isMobile={isMobile}`**

- [ ] **Step 5: svelte-check + 全量测试**

Run: `bun --filter remote-reader-web check && bun run test`
Expected: 0 error；全绿

- [ ] **Step 6: 提交**

```bash
git add apps/web/src/lib/components/RecentList.svelte apps/web/src/routes/+page.svelte
git commit -m "feat(web): 最近文档/浏览视图接入——双样式图标/⋯ 菜单/分享与转私有（isMobile 路由）"
```

---

### Task 9: Playwright 冒烟扩展

**Files:**
- Modify: 既有 Playwright 套件（先 `glob **/*.spec.ts` / 查 `package.json` scripts 定位；沿用其建号/登录/上传 fixture 方式）

- [ ] **Step 1: 定位既有套件与 fixture，追加用例（桌面视口 + 375×667 移动视口各跑一遍）**

用例清单：

1. 桌面：行内仅一个 ⋯；点击弹下拉菜单，文件行 6 项（私有）/5 项+转私有（共享）；点空白关闭、Esc 关闭
2. 桌面：点「复制分享链接」→ 浮层出现 `/s/` URL；input 值正确；关闭后行图标翻转为共享
3. 桌面：点「转为私有」→ confirm 接受 → 图标翻回私有；旧 `/s/<token>` 页面打开 404（fetch 状态码断言）
4. 移动：⋯ → 底部菜单项与桌面一致；backdrop 点击关闭
5. 移动：抽屉打开后点击右侧空白关闭
6. 三视图切换：`.segmented` 的 boundingBox.x 在三视图下一致（右贴边）
7. 双主题（data-theme=light/dark）截图对比图标可见性（既有视觉验收模式）

- [ ] **Step 2: 跑套件**

Run: 套件既有运行命令（`package.json` scripts 或 README 开发节）
Expected: 全过（含既有 13 项回归）

- [ ] **Step 3: 提交**

```bash
git add <套件文件>
git commit -m "test(e2e): FM 分享状态与菜单收敛冒烟——图标翻转/菜单项/复制链接/转私有/空白关闭/页签对齐"
```

---

### Task 10: 全量回归 + spec 现状补记 + 收尾

- [ ] **Step 1: 全量验证**

Run: `bun run test && bun --filter remote-reader-web check && bun run build`
Expected: 测试全绿；svelte-check 0 error；build 成功

- [ ] **Step 2: spec 补「实现现状」节（`docs/superpowers/specs/2026-09-16-fm-share-state-design.md` 末尾追加 §10 实现现状：落地差异/遗留备案，风格随既有 spec）**

- [ ] **Step 3: 提交收尾**

```bash
git add docs/superpowers/specs/2026-09-16-fm-share-state-design.md
git commit -m "docs: FM 分享状态 spec 补记实现现状"
```

---

## Self-Review 记录

- **Spec 覆盖**：§3.1→Task 1；§3.2→Task 2；§4→Task 3；§5.1→Task 4；§5.2/5.3→Task 5；§5.4/5.5→Task 6；§5.6/5.7/5.8+刷新→Task 7；RecentList 侧→Task 8；§8 测试→各 Task + Task 9/10。无缺口。
- **占位符扫描**：UI 模板改动处以「精确 before/after + 定位行号」表述（源文件已在规划期通读）；无 TBD。
- **类型一致性**：`rowActions(item: {type, shared})` 两处同签名；`onMore: (anchor: HTMLElement) => void` 贯穿 RowActions→两视图；`sharedDocIds/getOrCreateShareUrl/revokeAllShares` 签名与 Task 2/3 调用一致；`toDocDTO(r, shared=false)` 默认参保持 search 等旧调用方兼容。
