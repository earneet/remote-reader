# 「最近浏览」视图（owner 阅读顺序）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 文件管理器新增第三分段「最近浏览」——按 owner 本人真实浏览时间（`owner_viewed_at`）倒序平铺，跨浏览器定位上次阅读位置。

**Architecture:** 新列 `owner_viewed_at`（与 `last_viewed_at` 分层信号语义分工）+ 查看页 `onMount` 发 fire-and-forget beacon `POST /api/view/[id]`（机制性排除 hover 预取）+ 既有 recent 机制参数化出 `sort: 'updated' | 'viewed'`（keyset 分页 / `/api/recent` / `RecentList` 全复用）。

**Tech Stack:** SvelteKit（Svelte 5 runes）· Drizzle + better-sqlite3 · vitest（node 运行时）

**Spec:** `docs/superpowers/specs/2026-09-12-recently-viewed-design.md`（含 subagent 审查修正：索引创建收敛在列兜底之后；`RecentDoc` 字段定名 `ownerViewedAt` 零映射）

**关键运行时约束（来自 CLAUDE.md）：** 测试一律 `bun run test`（vitest 经 node shebang 跑，**不要** `bun` 直接跑测试）；类型检查 `bun --filter remote-reader-web check`；服务端文件 import 共享层用**相对路径**（vitest 无 `$lib` alias，先例 `api/recent/+server.ts` 的 `'../../../lib/shared/recent'`）。

---

### Task 1: DB 层——`owner_viewed_at` 列 + `documents_owner_type_viewed_idx` 索引

**Files:**
- Modify: `apps/web/src/lib/server/db/schema.ts:35-43`
- Modify: `apps/web/src/lib/server/db/index.ts:27-45, 92-111`
- Generate: `apps/web/src/lib/server/db/migrations/0005_*.sql`（`db:generate` 产出，文件名以实际为准）
- Test: `apps/web/tests/tiering-schema.test.ts`

- [ ] **Step 1: 写失败的回归测试**

在 `apps/web/tests/tiering-schema.test.ts` 末尾追加（`OLD_DOCUMENTS_SQL` 常量文件里已有，直接复用）：

```ts
// ===== owner_viewed_at（「最近浏览」spec §5.2/§10） =====

test('主库 documents 表含 owner_viewed_at 列与 documents_owner_type_viewed_idx 索引', () => {
    const cols = sqlite.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('owner_viewed_at');
    const idx = sqlite.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'documents_owner_type_viewed_idx'"
    ).get();
    expect(idx).toBeTruthy();
});

test('旧库（无 owner_viewed_at）经 ensureOwnerViewedColumn 升级出列与索引且幂等', () => {
    const raw = new Database(':memory:');
    raw.exec(OLD_DOCUMENTS_SQL);
    ensureOwnerViewedColumn(raw);
    ensureOwnerViewedColumn(raw); // 幂等重跑
    const cols = raw.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    expect(cols.map((c) => c.name)).toContain('owner_viewed_at');
    const idx = raw.prepare(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'documents_owner_type_viewed_idx'"
    ).get();
    expect(idx).toBeTruthy();
});
```

同时把文件顶部的 import 改为：

```ts
import { ensureOwnerViewedColumn, ensureTierColumns, sqlite } from '../src/lib/server/db';
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/tiering-schema.test.ts`
Expected: FAIL —— `ensureOwnerViewedColumn` 未导出（import 报错），两用例不通过

- [ ] **Step 3: 实现——schema.ts 声明**

`apps/web/src/lib/server/db/schema.ts` 的 `documents` 表（当前 35-37 行是 `storageTier/lastViewedAt/archivedAt`）在 `archivedAt` 之后加列，并在表索引对象里加 `ownerTypeViewedIdx`（列声明放最后，与运行时 `ALTER TABLE` 追加到表尾一致，保证新库/存量库列序相同）：

```ts
    storageTier: text('storage_tier', { enum: ['hot', 'cold'] }).notNull().default('hot'),
    lastViewedAt: integer('last_viewed_at'),
    archivedAt: integer('archived_at'),
    // 「最近浏览」信号（spec §5.1）：仅 owner 真实浏览（beacon 写入）；
    // 与 last_viewed_at（分层信号：任何人任何访问）语义分工，互不替代
    ownerViewedAt: integer('owner_viewed_at')
}, (t) => ({
    ownerParentIdx: index('documents_owner_parent_idx').on(t.ownerId, t.parentId),
    ownerParentNameTypeIdx: index('documents_owner_parent_name_type_idx').on(t.ownerId, t.parentId, t.name, t.type),
    ownerTypeUpdatedIdx: index('documents_owner_type_updated_idx')
        .on(t.ownerId, t.type, sql`${t.updatedAt} DESC`, sql`${t.id} DESC`),
    ownerTypeViewedIdx: index('documents_owner_type_viewed_idx')
        .on(t.ownerId, t.type, sql`${t.ownerViewedAt} DESC`, sql`${t.id} DESC`)
}));
```

- [ ] **Step 4: 实现——SCHEMA_SQL 只加列，索引收敛到 ensure 兜底之后（P0 修正）**

`apps/web/src/lib/server/db/index.ts`：

(a) SCHEMA_SQL 的 `CREATE TABLE IF NOT EXISTS documents` 里，`archived_at integer,` 之后加一行（**不要**在 SCHEMA_SQL 里加该索引的 `CREATE INDEX`——存量库上它会先于 ALTER 执行，`no such column` 直接炸掉模块顶层的 `ensureSchema()`；既有 SCHEMA_SQL 索引只引用原始列，无此问题）：

```sql
    archived_at integer,
    owner_viewed_at integer,
```

(b) `ensureTierColumns` 函数之后新增（92 行附近）：

```ts
// 「最近浏览」列（spec §5.2）：索引创建收敛在列补齐之后——若索引进 SCHEMA_SQL，
// 存量库（表已存在、CREATE TABLE 为 no-op）会在 prepare 阶段因列不存在抛错，启动即崩
export function ensureOwnerViewedColumn(target: SqliteDb): void {
    const cols = target.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('owner_viewed_at')) {
        target.exec('ALTER TABLE documents ADD COLUMN owner_viewed_at integer');
    }
    target.exec('CREATE INDEX IF NOT EXISTS documents_owner_type_viewed_idx ON documents (owner_id, type, owner_viewed_at DESC, id DESC)');
}
```

(c) `ensureSchema` 改为：

```ts
export function ensureSchema(): void {
    sqlite.exec(SCHEMA_SQL);
    ensureTierColumns(sqlite);
    ensureOwnerViewedColumn(sqlite);
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run test apps/web/tests/tiering-schema.test.ts`
Expected: PASS（含原有 2 个分层用例零回归）

- [ ] **Step 6: 生成 drizzle migration（三处一致）**

Run: `bun --filter remote-reader-web db:generate`
Expected: `apps/web/src/lib/server/db/migrations/` 新增 `0005_*.sql`（含 `ALTER TABLE documents ADD COLUMN owner_viewed_at integer` 与 `CREATE INDEX ... documents_owner_type_viewed_idx`）+ `meta/_journal.json` 更新。若索引列被生成为 ASC，无需手改——SQLite 对等值前缀后的纯 DESC 排序可反向扫描同一索引（2026-09-08 spec §5.2 已论证）。

- [ ] **Step 7: 全量测试快速回归**

Run: `bun run test`
Expected: 全绿（新列对现有查询是超集，无行为变化）

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/server/db/schema.ts apps/web/src/lib/server/db/index.ts apps/web/src/lib/server/db/migrations apps/web/tests/tiering-schema.test.ts
git commit -m "feat(web): documents 增 owner_viewed_at 列与 viewed 索引——索引收敛列兜底后，存量库升级回归"
```

---

### Task 2: `documents.ts`——`markOwnerViewed()` + `recentFiles()` sort 参数化

**Files:**
- Modify: `apps/web/src/lib/shared/recent.ts:3-15`
- Modify: `apps/web/src/lib/server/documents.ts:186-206`（recentFiles 重写）
- Modify: `apps/web/src/lib/server/documents.ts`（touchDocument 附近新增 markOwnerViewed）
- Modify: `apps/web/src/routes/api/recent/+server.ts:19-30`（调用点机械适配）
- Modify: `apps/web/src/routes/+page.server.ts:25-26`（调用点机械适配）
- Test: `apps/web/tests/documents.test.ts:429-492`

- [ ] **Step 1: 写失败测试**

`apps/web/tests/documents.test.ts` —— 先把既有 `recentFiles` 用例（429-492 行）的**全部调用点**改为新签名（3 种形态）：

```ts
// recentFiles(ownerId, null, 50)         → recentFiles(ownerId, 'updated', null, 50)
// recentFiles(ownerId, null, 1)          → recentFiles(ownerId, 'updated', null, 1)
// recentFiles(ownerId, { updatedAt: page1[0].updatedAt, id: page1[0].id }, 50)
//                                        → recentFiles(ownerId, 'updated', { ts: page1[0].updatedAt, id: page1[0].id }, 50)
```

再在文件末尾追加新用例：

```ts
// ===== markOwnerViewed + recentFiles sort=viewed（「最近浏览」spec §5.3/§5.4） =====

function setOwnerViewedAt(id: string, ts: number | null): void {
    db.update(schema.documents).set({ ownerViewedAt: ts }).where(eq(schema.documents.id, id)).run();
}

test('markOwnerViewed：命中且只写 owner_viewed_at（updated_at/last_viewed_at 不动）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    setUpdatedAt(a.id, 1_700_000_000_000);
    const before = Date.now();
    expect(markOwnerViewed(ownerId, a.id)).toBe(true);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, a.id)).get()!;
    expect(row.ownerViewedAt).toBeGreaterThanOrEqual(before);
    expect(row.updatedAt).toBe(1_700_000_000_000);
    expect(row.lastViewedAt).toBeNull();
});

test('markOwnerViewed：非本人 / folder / 不存在 → false', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', ['fold']); // 顺带建 folder 'fold'
    const other = generateId();
    db.insert(schema.users).values({
        id: other, email: `mv-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    expect(markOwnerViewed(other, a.id)).toBe(false);
    const folder = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.type, 'folder'))).get()!;
    expect(markOwnerViewed(ownerId, folder.id)).toBe(false);
    expect(markOwnerViewed(ownerId, 'nonexistent')).toBe(false);
});

test('recentFiles sort=viewed：按 owner_viewed_at DESC，未浏览不出现', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    await uploadDocument(ownerId, 'c.md', 'z', []); // 从未浏览
    const T = 1_700_000_000_000;
    setOwnerViewedAt(a.id, T);
    setOwnerViewedAt(b.id, T + 10);
    const rows = recentFiles(ownerId, 'viewed', null, 50);
    expect(rows.map((r) => r.name)).toEqual(['b.md', 'a.md']);
});

test('recentFiles sort=viewed：cursor keyset 排除自身与更旧行', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setOwnerViewedAt(a.id, T);
    setOwnerViewedAt(b.id, T - 10);
    const page1 = recentFiles(ownerId, 'viewed', null, 1);
    expect(page1.map((r) => r.name)).toEqual(['a.md']);
    const page2 = recentFiles(ownerId, 'viewed', { ts: page1[0].ownerViewedAt!, id: page1[0].id }, 50);
    expect(page2.map((r) => r.name)).toEqual(['b.md']);
});

test('recentFiles sort=viewed：owner 隔离', async () => {
    const other = generateId();
    db.insert(schema.users).values({
        id: other, email: `vv-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    await uploadDocument(ownerId, 'mine.md', 'x', []);
    const theirs = await uploadDocument(other, 'theirs.md', 'y', []);
    setOwnerViewedAt(theirs.id, 1_700_000_000_000);
    expect(recentFiles(ownerId, 'viewed', null, 50)).toEqual([]);
});
```

文件顶部 import 补 `markOwnerViewed`（与 `recentFiles`、`uploadDocument` 同源）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/documents.test.ts`
Expected: FAIL —— `markOwnerViewed` 未导出；`recentFiles` 3 参/4 参不匹配（TS 层面即报错）

- [ ] **Step 3: 实现——共享契约先落 `RecentSort`**

`apps/web/src/lib/shared/recent.ts` 全文替换为：

```ts
// 「最近文档」/「最近浏览」视图的共享契约：页面 load 与 /api/recent 端点都产出该形状，RecentList 组件只认它（spec §5.3/§6.2）。
// 服务端实际返回 DocumentRow & { tags }（字段是超集，结构兼容本类型）；目录视图的 children 今天就这么跨边界。
export const RECENT_PAGE_SIZE = 50;

// 排序维度（spec §5.4/§6.2）：updated = updated_at（「最近文档」）；viewed = owner_viewed_at（「最近浏览」）
export type RecentSort = 'updated' | 'viewed';

export type RecentDoc = {
    id: string;
    parentId: string | null;
    name: string;
    type: 'file' | 'folder';
    sizeBytes: number | null;
    createdAt: number;
    updatedAt: number;
    ownerViewedAt: number | null;
    storageTier: 'hot' | 'cold';
    tags: { id: string; name: string }[];
};
```

- [ ] **Step 4: 实现——documents.ts**

(a) 文件顶部 import 区加（`./fts` import 之后，相对路径——vitest 无 `$lib` alias）：

```ts
import type { RecentSort } from '../shared/recent';
```

(b) `recentFiles`（186-206 行）整体替换为：

```ts
// 「最近文档/浏览」视图：全局平铺该用户的文件（含 cold 归档行，只读元数据），
// sort 决定排序键与过滤（spec §5.4）：updated → updated_at DESC（现状）；viewed → owner_viewed_at DESC 且排除未浏览。
// keyset 分页：cursor 为上一页末行的 (ts, id)，严格小于比较保证无漏无重（spec §5.1）。
// id 决胜仅为全序确定性：id 非单调，同毫秒内顺序无时间语义，不影响分页正确性。
export function recentFiles(
    ownerId: string,
    sort: RecentSort,
    cursor: { ts: number; id: string } | null,
    limit: number
): DocumentRow[] {
    const conds = [
        eq(schema.documents.ownerId, ownerId),
        eq(schema.documents.type, 'file')
    ];
    if (sort === 'viewed') {
        conds.push(isNotNull(schema.documents.ownerViewedAt));
    }
    const orderCol = sort === 'viewed' ? schema.documents.ownerViewedAt : schema.documents.updatedAt;
    if (cursor) {
        conds.push(sql`(${orderCol}, ${schema.documents.id}) < (${cursor.ts}, ${cursor.id})`);
    }
    return db.select().from(schema.documents)
        .where(and(...conds))
        .orderBy(sql`${orderCol} DESC`, sql`${schema.documents.id} DESC`)
        .limit(limit)
        .all();
}
```

（`isNotNull` 已在文件现有 drizzle-orm import 里。）

(c) `touchDocument`（约 404 行）之后新增：

```ts
// 「最近浏览」信号（spec §5.3）：beacon 端点调用，仅 owner 真实浏览时触发；
// 只动 owner_viewed_at——不碰 updated_at（排序语义）/ last_viewed_at（分层语义）/ storage_tier
export function markOwnerViewed(ownerId: string, docId: string): boolean {
    const r = db.update(schema.documents).set({ ownerViewedAt: Date.now() })
        .where(and(
            eq(schema.documents.id, docId),
            eq(schema.documents.ownerId, ownerId),
            eq(schema.documents.type, 'file')
        ))
        .run();
    return r.changes > 0;
}
```

- [ ] **Step 5: 机械适配两个运行时调用点（保持全绿）**

(a) `apps/web/src/routes/api/recent/+server.ts`：cursor 解析处 `cursor = { updatedAt: Number.parseInt(tsStr, 10), id }` 改为 `cursor = { ts: Number.parseInt(tsStr, 10), id }`；调用处 `recentFiles(locals.user.id, cursor, limit)` 改为 `recentFiles(locals.user.id, 'updated', cursor, limit)`。

(b) `apps/web/src/routes/+page.server.ts`：`recentFiles(locals.user.id, null, RECENT_PAGE_SIZE)` 改为 `recentFiles(locals.user.id, 'updated', null, RECENT_PAGE_SIZE)`。

- [ ] **Step 6: 跑测试确认通过**

Run: `bun run test apps/web/tests/documents.test.ts apps/web/tests/recent-api.test.ts apps/web/tests/file-manager.test.ts`
Expected: PASS（新用例过 + 既有用例经签名适配后零回归）

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/shared/recent.ts apps/web/src/lib/server/documents.ts apps/web/src/routes/api/recent/+server.ts apps/web/src/routes/+page.server.ts apps/web/tests/documents.test.ts
git commit -m "feat(web): documents 增 markOwnerViewed + recentFiles sort 参数——浏览序/未浏览排除/仅动单列"
```

---

### Task 3: beacon 端点 `POST /api/view/[id]`

**Files:**
- Create: `apps/web/src/routes/api/view/[id]/+server.ts`
- Test: `apps/web/tests/view-api.test.ts`（新）

- [ ] **Step 1: 写失败测试**

新建 `apps/web/tests/view-api.test.ts`（清理模式照抄 `recent-api.test.ts`）：

```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';

const { POST } = await import('../src/routes/api/view/[id]/+server');

const TMP = `./data/test-view-${Date.now().toString(36)}`;
let ownerId: string;

beforeEach(() => {
    process.env.DATA_DIR = TMP;
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId, email: `t-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
});

afterEach(() => {
    try { rmSync(TMP, { recursive: true, force: true }); } catch {}
});

async function call(userId: string | null, id: string): Promise<Response> {
    return POST({
        locals: { user: userId ? { id: userId } : null },
        params: { id }
    } as Parameters<typeof POST>[0]);
}

test('无 session → 401', async () => {
    await expect(call(null, 'x')).rejects.toMatchObject({ status: 401 });
});

test('文档不存在 → 404', async () => {
    await expect(call(ownerId, 'nonexistent')).rejects.toMatchObject({ status: 404 });
});

test('他人文档 → 404（不泄露存在性）', async () => {
    const other = generateId();
    db.insert(schema.users).values({
        id: other, email: `t2-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    await expect(call(other, a.id)).rejects.toMatchObject({ status: 404 });
});

test('folder → 404', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['fold']); // 顺带建 folder 'fold'
    const folder = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.type, 'folder'))).get()!;
    await expect(call(ownerId, folder.id)).rejects.toMatchObject({ status: 404 });
});

test('成功 → 204 且库内 owner_viewed_at 更新', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const before = Date.now();
    const r = await call(ownerId, a.id);
    expect(r.status).toBe(204);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, a.id)).get()!;
    expect(row.ownerViewedAt).toBeGreaterThanOrEqual(before);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/view-api.test.ts`
Expected: FAIL —— 模块 `../src/routes/api/view/[id]/+server` 不存在

- [ ] **Step 3: 实现端点**

新建 `apps/web/src/routes/api/view/[id]/+server.ts`：

```ts
import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { markOwnerViewed } from '$server/documents';

// 「最近浏览」写入侧（spec §6.1）：查看页 onMount 上报；认证与 owner 校验都在服务端。
// 404 不泄露存在性（与库内既有口径一致）；成功 204 无 body。
export const POST: RequestHandler = async ({ locals, params }) => {
    if (!locals.user) error(401, 'unauthorized');
    if (!markOwnerViewed(locals.user.id, params.id)) error(404, 'not found');
    return new Response(null, { status: 204 });
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/view-api.test.ts`
Expected: PASS（5 用例全过）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/api/view/[id]/+server.ts apps/web/tests/view-api.test.ts
git commit -m "feat(web): POST /api/view/[id]——「最近浏览」beacon 端点（session+owner 校验，404 不泄露）"
```

---

### Task 4: `/api/recent` 增 `sort` 参数

**Files:**
- Modify: `apps/web/src/routes/api/recent/+server.ts`（全文重构，见 Step 3）
- Test: `apps/web/tests/recent-api.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/web/tests/recent-api.test.ts` 末尾追加：

```ts
// ===== sort=viewed（「最近浏览」spec §6.2） =====

function setOwnerViewedAt(id: string, ts: number | null): void {
    db.update(schema.documents).set({ ownerViewedAt: ts }).where(eq(schema.documents.id, id)).run();
}

test('sort=viewed：按 owner_viewed_at DESC，未浏览不出现（updated 再新也不入序）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []); // 未浏览
    const T = 1_700_000_000_000;
    setUpdatedAt(b.id, T + 100);
    setOwnerViewedAt(a.id, T);
    const r = await call(ownerId, '?sort=viewed');
    const body = await r.json() as { items: { name: string }[] };
    expect(body.items.map((i) => i.name)).toEqual(['a.md']);
});

test('sort=viewed：before cursor 按 owner_viewed_at 解释', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setOwnerViewedAt(a.id, T);
    setOwnerViewedAt(b.id, T - 10);
    const r = await call(ownerId, `?sort=viewed&before=${T}_${a.id}`);
    const body = await r.json() as { items: { name: string }[] };
    expect(body.items.map((i) => i.name)).toEqual(['b.md']);
});

test('非法 sort → 400', async () => {
    await expect(call(ownerId, '?sort=bogus')).rejects.toMatchObject({ status: 400 });
});

test('缺省 sort 默认 updated（回归锁）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    setOwnerViewedAt(b.id, null);
    const T = 1_700_000_000_000;
    setUpdatedAt(a.id, T);
    setUpdatedAt(b.id, T + 5);
    const r = await call(ownerId);
    const body = await r.json() as { items: { name: string }[] };
    expect(body.items.map((i) => i.name)).toEqual(['b.md', 'a.md']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/recent-api.test.ts`
Expected: FAIL —— `sort=viewed` 用例返回的是 updated 序；`sort=bogus` 未 400

- [ ] **Step 3: 实现端点重构**

`apps/web/src/routes/api/recent/+server.ts` 全文替换为：

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { recentFiles } from '$server/documents';
import { listTagsForDocs } from '$server/tags';
import { RECENT_PAGE_SIZE, type RecentSort } from '../../../lib/shared/recent';

const MAX_LIMIT = 2000; // re-sync 深度上限（spec §5.3，与 §7 性能论证对齐）

export const GET: RequestHandler = async ({ locals, url }) => {
    if (!locals.user) error(401, 'unauthorized');

    // sort（spec §6.2）：缺省 updated 向后兼容；非法值 400（同 limit/before 严格风格）
    const rawSort = url.searchParams.get('sort');
    if (rawSort !== null && rawSort !== 'updated' && rawSort !== 'viewed') error(400, 'invalid sort');
    const sort: RecentSort = rawSort === 'viewed' ? 'viewed' : 'updated';

    let limit = RECENT_PAGE_SIZE;
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit !== null) {
        if (!/^\d+$/.test(rawLimit)) error(400, 'invalid limit');
        limit = Math.min(Math.max(Number.parseInt(rawLimit, 10), 1), MAX_LIMIT);
    }

    // cursor 格式 <ts>_<id>：ts 语义按 sort 解释（updated → updated_at，viewed → owner_viewed_at）；
    // id 是 UUID+base36（不含 _），分隔符安全（spec §5.3）
    let cursor: { ts: number; id: string } | null = null;
    const rawBefore = url.searchParams.get('before');
    if (rawBefore !== null) {
        const sep = rawBefore.indexOf('_');
        const tsStr = sep > 0 ? rawBefore.slice(0, sep) : '';
        const id = sep > 0 ? rawBefore.slice(sep + 1) : '';
        if (!/^\d+$/.test(tsStr) || !id) error(400, 'invalid before');
        cursor = { ts: Number.parseInt(tsStr, 10), id };
    }

    const rows = recentFiles(locals.user.id, sort, cursor, limit);
    const tagsByDoc = listTagsForDocs(rows.map((r) => r.id), locals.user.id);
    return json({ items: rows.map((r) => ({ ...r, tags: tagsByDoc.get(r.id) ?? [] })) });
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/recent-api.test.ts`
Expected: PASS（新 4 用例 + 既有 9 用例零回归）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/api/recent/+server.ts apps/web/tests/recent-api.test.ts
git commit -m "feat(web): GET /api/recent 增 sort 参数——viewed 排序 + before 按 sort 解释"
```

---

### Task 5: 查看页写入点——view-beacon + 两个 load 增返字段 + onMount 上报

**Files:**
- Create: `apps/web/src/lib/shared/view-beacon.ts`
- Modify: `apps/web/src/routes/d/[id]/+page.server.ts:26`
- Modify: `apps/web/src/routes/s/[token]/+page.server.ts:11, 30`
- Modify: `apps/web/src/routes/d/[id]/+page.svelte:1-10`
- Modify: `apps/web/src/routes/s/[token]/+page.svelte:1-5`
- Test: `apps/web/tests/share-view.test.ts`、`apps/web/tests/d-view.test.ts`

- [ ] **Step 1: 写失败测试**

(a) `apps/web/tests/share-view.test.ts` 末尾追加：

```ts
// ===== 「最近浏览」写入侧（spec §7.1） =====

test('load 返回 id 与 ownerView：owner session → true，无 session → false', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const diskPath = join(process.env.DATA_DIR ?? './data/documents', ownerId, 'a.md');
    await writeFile(diskPath, '# T');
    const docId = generateId();
    db.insert(schema.documents).values({
        id: docId, ownerId, parentId: null, name: 'a.md', type: 'file',
        storagePath: diskPath, contentHash: null, sizeBytes: null,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    const { token } = await createShareLink(docId);
    const hit = (await load({
        locals: { user: { id: ownerId } }, params: { token }, setHeaders: () => {}
    } as unknown as Parameters<typeof load>[0])) as { id: string; ownerView: boolean };
    expect(hit.id).toBe(docId);
    expect(hit.ownerView).toBe(true);
    const anon = (await load({
        locals: { user: null }, params: { token }, setHeaders: () => {}
    } as unknown as Parameters<typeof load>[0])) as { ownerView: boolean };
    expect(anon.ownerView).toBe(false);
});
```

(b) `apps/web/tests/d-view.test.ts` 末尾追加（`insertUser`/文档构造沿用该文件既有 helper；若无现成 helper，照 share-view 的写法内联）：

```ts
test('load 返回 id（「最近浏览」beacon 用，spec §7.1）', async () => {
    // 沿用本文件既有的 owner+磁盘文档构造方式，断言：
    const result = (await load({
        locals: { user: { id: ownerId } }, params: { id: docId }, setHeaders: () => {}
    } as unknown as Parameters<typeof load>[0])) as { id: string };
    expect(result.id).toBe(docId);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/share-view.test.ts apps/web/tests/d-view.test.ts`
Expected: FAIL —— 返回对象无 `id`/`ownerView` 字段

- [ ] **Step 3: 实现——beacon 客户端函数**

新建 `apps/web/src/lib/shared/view-beacon.ts`：

```ts
// 「最近浏览」上报（spec §7.1）：查看页 onMount 调用；fire-and-forget，失败静默——
// 阅读顺序是便利功能，丢一次上报可接受；keepalive 提高关页前送达率
export function reportView(docId: string): void {
    void fetch(`/api/view/${encodeURIComponent(docId)}`, { method: 'POST', keepalive: true }).catch(() => {});
}
```

- [ ] **Step 4: 实现——两个 load 增返字段**

(a) `apps/web/src/routes/d/[id]/+page.server.ts` 的 load 返回行改为：

```ts
    return { id: doc.id, title: doc.name, html, tags, updatedAt: doc.updatedAt, sizeBytes: doc.sizeBytes };
```

(b) `apps/web/src/routes/s/[token]/+page.server.ts`：load 签名加 `locals` 解构、返回行改为：

```ts
export const load: PageServerLoad = async ({ locals, params, setHeaders }) => {
```

```ts
    // 「最近浏览」写入侧（spec §7.1）：owner 登录态打开分享链接也算一次浏览——
    // hooks 全局解析 session，/s/ 免登录特性不变（无 session → ownerView=false，客户端不上报）
    return { id: doc.id, ownerView: locals.user?.id === doc.ownerId, title: doc.name, html };
```

- [ ] **Step 5: 实现——两个页面 onMount 上报**

(a) `apps/web/src/routes/d/[id]/+page.svelte` 的 script 块顶部加 import 与 onMount：

```svelte
    import { onMount } from 'svelte';
    import { reportView } from '$lib/shared/view-beacon';
```

`let { data } = $props();` 之后加：

```svelte
    // 「最近浏览」上报（spec §7.1）：onMount 仅真实导航挂载时执行——
    // hover 预取只跑 load 不挂载组件，机制性排除；invalidateAll 不重挂载 → 不误记
    onMount(() => { reportView(data.id); });
```

(b) `apps/web/src/routes/s/[token]/+page.svelte` 同样加 import，`let { data } = $props();` 之后加：

```svelte
    // 仅 owner 登录态上报（匿名访客不算浏览，spec §3 浏览口径）；服务端仍会校验 owner
    onMount(() => { if (data.ownerView) reportView(data.id); });
```

- [ ] **Step 6: 跑测试确认通过 + 类型检查**

Run: `bun run test apps/web/tests/share-view.test.ts apps/web/tests/d-view.test.ts && bun --filter remote-reader-web check`
Expected: 测试 PASS；svelte-check 0 错

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/shared/view-beacon.ts apps/web/src/routes/d/[id]/+page.server.ts apps/web/src/routes/d/[id]/+page.svelte apps/web/src/routes/s/[token]/+page.server.ts apps/web/src/routes/s/[token]/+page.svelte apps/web/tests/share-view.test.ts apps/web/tests/d-view.test.ts
git commit -m "feat(web): 查看页 onMount 上报浏览——/d/ 与 /s/(owner) 双入口，hover 预取机制性排除"
```

---

### Task 6: 文件管理器——root load `view=viewed` 分支 + `RecentList` sort 参数化 + 三段切换

**Files:**
- Modify: `apps/web/src/routes/+page.server.ts:18-37`（load 视图分支）
- Modify: `apps/web/src/lib/components/RecentList.svelte:1-58, 90, 148-149, 171`（sort prop / cursor 字段 / 请求 URL / 时间列 / 空状态）
- Modify: `apps/web/src/routes/+page.svelte:74, 87-111`（三段控件 / h1 / 视图分支）
- Test: `apps/web/tests/file-manager.test.ts`

- [ ] **Step 1: 写失败测试**

`apps/web/tests/file-manager.test.ts` 末尾追加：

```ts
// ===== load 视图分支（viewed，「最近浏览」spec §7.2） =====

function setOwnerViewedAt(id: string, ts: number | null): void {
    db.update(schema.documents).set({ ownerViewedAt: ts }).where(eq(schema.documents.id, id)).run();
}

test('load：view=viewed 返回按浏览序的 viewed 且 children/recent 空', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setOwnerViewedAt(a.id, T);
    setOwnerViewedAt(b.id, T + 1);
    const data = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/?view=viewed') } as any);
    expect((data as any).view).toBe('viewed');
    expect((data as any).children).toEqual([]);
    expect((data as any).viewed.map((r: any) => r.name)).toEqual(['b.md', 'a.md']);
    expect((data as any).recent).toEqual([]);
});

test('load：view=viewed 未浏览不出现；dir/recent 分支 viewed 为空', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await uploadDocument(ownerId, 'a.md', 'x', []);
    const viewedData = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/?view=viewed') } as any);
    expect((viewedData as any).viewed).toEqual([]);
    const dirData = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/') } as any);
    expect((dirData as any).viewed).toEqual([]);
});

test('load：view 非法值回落 dir（既有模式扩展）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const data = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/?view=bogus') } as any);
    expect((data as any).view).toBe('dir');
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/file-manager.test.ts`
Expected: FAIL —— `view=viewed` 被判为 `dir`（现行只认 `recent`），`viewed` 字段不存在

- [ ] **Step 3: 实现——root load 视图分支**

`apps/web/src/routes/+page.server.ts` 的 load（18-37 行）改为：

```ts
export const load: PageServerLoad = async ({ locals, url }) => {
    if (!locals.user) redirect(302, '/login');
    const rawView = url.searchParams.get('view');
    const view = rawView === 'recent' ? 'recent' as const
        : rawView === 'viewed' ? 'viewed' as const
        : 'dir' as const;
    // 公共数据：左树（folders/计数）+ 标签编辑（allTags）所有视图都要（spec §6.1）
    const folders = listFolders(locals.user.id);
    const folderCounts = folderChildCounts(locals.user.id);
    const allTags = listTags(locals.user.id);
    if (view === 'recent' || view === 'viewed') {
        const rows = recentFiles(locals.user.id, view === 'viewed' ? 'viewed' : 'updated', null, RECENT_PAGE_SIZE);
        const tagsByDoc = listTagsForDocs(rows.map((r) => r.id), locals.user.id);
        const list = rows.map((r) => ({ ...r, tags: tagsByDoc.get(r.id) ?? [] }));
        return {
            view, children: [], folders, currentDir: null, tagsByDoc, allTags, folderCounts,
            recent: view === 'recent' ? list : [],
            viewed: view === 'viewed' ? list : []
        };
    }
    const dir = url.searchParams.get('dir');
    const parentId = dir && dir.length > 0 ? dir : null;
    const children = listChildren(locals.user.id, parentId);
    const fileIds = children.filter((c) => c.type === 'file').map((c) => c.id);
    const tagsByDoc = listTagsForDocs(fileIds, locals.user.id);
    return { view, children, folders, currentDir: parentId, tagsByDoc, allTags, folderCounts, recent: [], viewed: [] };
};
```

- [ ] **Step 4: 实现——RecentList sort 参数化**

`apps/web/src/lib/components/RecentList.svelte`：

(a) import 行改为：

```svelte
    import { RECENT_PAGE_SIZE, type RecentDoc, type RecentSort } from '$lib/shared/recent';
```

(b) props 解构（8-22 行）加 `sort`：

```svelte
    let {
        initialRows,
        sort,
        folderById,
        scrollRoot,
        movingId,
        onStartMove,
        onCancelMove
    }: {
        initialRows: RecentDoc[];
        sort: RecentSort;
        folderById: Map<string, TreeFolder>;
        scrollRoot: HTMLElement | null;
        movingId: string | null;
        onStartMove: (id: string) => void;
        onCancelMove: () => void;
    } = $props();
```

(c) `cursorOfLast`（55-58 行）改为按 sort 取字段：

```svelte
    function cursorOfLast(): string | null {
        const last = rows[rows.length - 1];
        if (!last) return null;
        const ts = sort === 'viewed' ? last.ownerViewedAt : last.updatedAt;
        return `${ts}_${last.id}`;
    }
```

(d) `loadMore` 的 fetch URL（68 行）与 `reSync` 的 fetch URL（90 行）分别改为：

```svelte
            const r = await fetch(`/api/recent?sort=${sort}&before=${encodeURIComponent(before)}`);
```

```svelte
            const r = await fetch(`/api/recent?sort=${sort}&limit=${limit}`);
```

(e) 时间列（171 行）改为排序键对应时间，viewed 加「看过 · 」前缀：

```svelte
                    {#if sort === 'viewed'}
                        <span class="time" title={new Date(item.ownerViewedAt ?? item.updatedAt).toLocaleString()}>看过 · {formatRelative(item.ownerViewedAt ?? item.updatedAt)}</span>
                    {:else}
                        <span class="time" title={new Date(item.updatedAt).toLocaleString()}>{formatRelative(item.updatedAt)}</span>
                    {/if}
```

(f) 空状态（148-149 行）改为按 sort 区分文案：

```svelte
{#if rows.length === 0}
    <p class="muted empty">{sort === 'viewed' ? '还没有浏览记录，打开过的文档会出现在这里。' : '还没有文档，让 Agent 通过 MCP 上传吧。'}</p>
{:else}
```

- [ ] **Step 5: 实现——+page.svelte 三段切换**

`apps/web/src/routes/+page.svelte`：

(a) FolderTree 的 `currentId`（74 行）改为：

```svelte
            currentId={view === 'dir' ? currentDir : undefined}
```

(b) h1（87 行）改为：

```svelte
                <h1>{view === 'recent' ? '最近文档' : view === 'viewed' ? '最近浏览' : currentDir ? '子目录' : '根目录'}</h1>
```

(c) 分段控件（88-93 行）改为三段：

```svelte
                <div class="segmented" role="group" aria-label="视图切换">
                    <button type="button" class="seg-btn" class:active={view === 'dir'}
                        aria-pressed={view === 'dir'} onclick={() => switchView('/')}>目录内容</button>
                    <button type="button" class="seg-btn" class:active={view === 'recent'}
                        aria-pressed={view === 'recent'} onclick={() => switchView('/?view=recent')}>最近文档</button>
                    <button type="button" class="seg-btn" class:active={view === 'viewed'}
                        aria-pressed={view === 'viewed'} onclick={() => switchView('/?view=viewed')}>最近浏览</button>
                </div>
```

(d) 新建文件夹表单条件（95 行）改为：

```svelte
            {#if view === 'dir'}
```

(e) 内容区分支（102-112 行）改为三向（recent 与 viewed 各占一个分支——**跨分支切换会销毁重建 RecentList**，本地 rows 状态按视图重初始化，这正是 mount-once 契约所需）：

```svelte
        {#if view === 'recent'}
            <RecentList
                bind:this={recentRef}
                initialRows={data.recent}
                sort="updated"
                folderById={folderById}
                scrollRoot={rightPane}
                movingId={movingId}
                onStartMove={startMove}
                onCancelMove={() => (movingId = null)}
            />
        {:else if view === 'viewed'}
            <RecentList
                bind:this={recentRef}
                initialRows={data.viewed}
                sort="viewed"
                folderById={folderById}
                scrollRoot={rightPane}
                movingId={movingId}
                onStartMove={startMove}
                onCancelMove={() => (movingId = null)}
            />
        {:else}
```

（`{:else}` 之后接现有目录列表代码，不动。）

- [ ] **Step 6: 跑测试 + 类型检查**

Run: `bun run test apps/web/tests/file-manager.test.ts && bun --filter remote-reader-web check`
Expected: 测试 PASS（新 3 用例 + 既有零回归）；svelte-check 0 错（`data.viewed` 类型由 load 推导）

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/+page.server.ts apps/web/src/lib/components/RecentList.svelte apps/web/src/routes/+page.svelte apps/web/tests/file-manager.test.ts
git commit -m "feat(web): 文件管理器三段切换——「最近浏览」视图接线（RecentList sort 参数化）"
```

---

### Task 7: 全量验证 + 实现状态同步

**Files:**
- Modify: `docs/superpowers/specs/2026-09-12-recently-viewed-design.md:4`（状态翻转）
- Modify: `CLAUDE.md`（当前状态段）

- [ ] **Step 1: 全量类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 错误

- [ ] **Step 2: 全量测试**

Run: `bun run test`
Expected: 全绿（预计 342 → ~360：tiering-schema +2、documents +5、view-api 新 5、recent-api +4、share-view +1、d-view +1、file-manager +3，以实际为准）

- [ ] **Step 3: 手动冒烟（spec §11.8，dev server 起 `bun run dev`）**

1. 登录后开若干 `/d/<id>` → 回文件管理器切「最近浏览」→ 刚看过的浮顶、时间列显示「看过 · X 前」
2. 换浏览器（或隐身窗）登录同一账号 → 「最近浏览」顺序一致（跨浏览器目标达成）
3. 退出登录匿名开 `/s/<token>` → 不入浏览序
4. 文件管理器列表 hover 文件链接数秒（预取触发）→ 不入浏览序
5. 「最近浏览」视图滚动到底 → loadMore 正常追加（cursor 走 `owner_viewed_at`）
6. 冷归档文档出现在列表且可点开（若配置了对象存储）

- [ ] **Step 4: 文档同步**

(a) spec 第 4 行状态改为：

```markdown
- **状态**: 已实现并 merge `master`（实现计划：`../plans/2026-09-12-recently-viewed.md`）
```

(b) `CLAUDE.md`「当前状态」段追加一段（紧跟最近文档视图那段之后，风格一致）：

```markdown
**最近浏览视图（2026-09-12）**：文件管理器第三分段「最近浏览」（URL `?view=viewed`）按 owner 本人浏览时间倒序；新列 `owner_viewed_at`（与 `last_viewed_at` 分层信号语义分工）；查看页 onMount 发 beacon `POST /api/view/[id]`（session+owner 校验，hover 预取机制性排除）；`recentFiles`/`/api/recent`/`RecentList` 参数化 `sort=updated|viewed`（keyset 游标按 sort 解释）。索引 `documents_owner_type_viewed_idx` 收敛在 `ensureOwnerViewedColumn` 列兜底后创建（存量库升级安全）。spec：`docs/superpowers/specs/2026-09-12-recently-viewed-design.md`。
```

并同步更新该文件中的测试计数（「342 单测」→ 实际数字）。

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-12-recently-viewed-design.md CLAUDE.md
git commit -m "docs: 最近浏览视图实现状态同步——spec 翻转 + CLAUDE.md 当前状态"
```

---

## 自审记录（writing-plans Self-Review）

1. **Spec 覆盖**：§5.1（两列分工注释）→ Task 1 schema 注释 + Task 2 markOwnerViewed 注释；§5.2（迁移四处同步 + 索引次序）→ Task 1；§5.3 → Task 2；§5.4 → Task 2/4；§6.1 → Task 3；§6.2 → Task 4；§7.1 → Task 5；§7.2 → Task 6；§10 各行 → Task 1/2/3/4/5/6 测试步骤；§11.8 冒烟 → Task 7 Step 3。无遗漏。
2. **占位符扫描**：无 TBD/TODO；d-view 测试步骤注明「沿用该文件既有 helper，若无则内联」并给出内联参照（share-view 同款）——执行者零上下文可完成。
3. **类型一致性**：`RecentSort` 定义于 `$lib/shared/recent.ts`（Task 2 Step 3），`documents.ts` 相对路径 import（Task 2 Step 4a），`/api/recent` import（Task 4 Step 3），`RecentList` prop（Task 6 Step 4b）——四处同源。`recentFiles(ownerId, sort, cursor: {ts,id}, limit)` 签名在 Task 2 定义、Task 2 Step 5 / Task 4 / Task 6 Step 3 三处调用一致。字段名全链路 `ownerViewedAt`（spec P1 修正落地）。
