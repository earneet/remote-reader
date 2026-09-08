# 「最近文档」平铺视图实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 文件管理器右栏新增「最近文档」视图：按 `updated_at DESC` 全局平铺文件、keyset 分页无限滚动、左树常驻分段切换（URL `?view=recent`）。

**Architecture:** 数据层新增 `recentFiles()`（keyset 游标查询 + 专用索引三处同步）；session 认证端点 `GET /api/recent` 服务无限滚动与操作后 re-sync；新组件 `RecentList.svelte` 持本地 rows 状态（挂载初始化 / 追加 / re-sync 整体替换），页面按 `data.view` 分支渲染，目录视图零改动。

**Tech Stack:** SvelteKit 2 + Svelte 5（runes）、Drizzle ORM 0.36 + better-sqlite3、vitest（node 运行时）。

**Spec:** `docs/superpowers/specs/2026-09-08-recent-documents-view-design.md`（本计划的唯一权威依据）

**运行时纪律（勿违反）：** 测试一律 `bun run test ...`（vitest 在 node 下跑，`bun` 直跑 TS 会触发 better-sqlite3 加载失败）；dev/build 用 bun；不要 `bun build --compile`。

---

### Task 1: 数据层 `recentFiles()`（TDD）

**Files:**
- Modify: `apps/web/src/lib/server/documents.ts`（在 `listFolders` 之后、`folderChildCounts` 注释之前插入）
- Test: `apps/web/tests/documents.test.ts`（文件末尾追加）

- [ ] **Step 1: 写失败测试**

在 `apps/web/tests/documents.test.ts` 的 import 块（第 5-14 行）中加入 `recentFiles`：

```ts
import {
    uploadDocument,
    listChildren,
    listFolders,
    folderChildCounts,
    recentFiles,
    getOwnedDocument,
    renameNode,
    moveNode,
    deleteNode
} from '../src/lib/server/documents';
```

在文件末尾追加（`setUpdatedAt` 用于绕开 `uploadDocument` 统一的时间戳，让排序可断言）：

```ts
// ===== recentFiles（「最近文档」视图，spec §5.1） =====

function setUpdatedAt(id: string, ts: number): void {
    db.update(schema.documents).set({ updatedAt: ts }).where(eq(schema.documents.id, id)).run();
}

test('recentFiles：按 updated_at DESC 全局排序（跨目录）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', ['r1']);
    const b = await uploadDocument(ownerId, 'b.md', 'y', ['r2']);
    const c = await uploadDocument(ownerId, 'c.md', 'z', []);
    const T = 1_700_000_000_000;
    setUpdatedAt(a.id, T);
    setUpdatedAt(b.id, T + 10);
    setUpdatedAt(c.id, T + 5);
    const rows = recentFiles(ownerId, null, 50);
    expect(rows.map((r) => r.name)).toEqual(['b.md', 'c.md', 'a.md']);
});

test('recentFiles：仅文件，不含文件夹', async () => {
    await uploadDocument(ownerId, 'f.md', 'x', ['fold']); // 会顺带建 folder 'fold'
    const rows = recentFiles(ownerId, null, 50);
    expect(rows.every((r) => r.type === 'file')).toBe(true);
});

test('recentFiles：cursor 排除自身与更新行（keyset）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setUpdatedAt(a.id, T);
    setUpdatedAt(b.id, T - 10);
    const page1 = recentFiles(ownerId, null, 1);
    expect(page1.map((r) => r.name)).toEqual(['a.md']);
    const page2 = recentFiles(ownerId, { updatedAt: page1[0].updatedAt, id: page1[0].id }, 50);
    expect(page2.map((r) => r.name)).toEqual(['b.md']);
});

test('recentFiles：同 updated_at 按 id DESC 决胜（keyset 全序）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setUpdatedAt(a.id, T);
    setUpdatedAt(b.id, T);
    const rows = recentFiles(ownerId, null, 50);
    const idDesc = [a.id, b.id].sort().reverse().join(',');
    expect(rows.map((r) => r.id).join(',')).toBe(idDesc);
});

test('recentFiles：owner 隔离', async () => {
    const other = generateId();
    db.insert(schema.users).values({
        id: other, email: `t2-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    await uploadDocument(ownerId, 'mine.md', 'x', []);
    await uploadDocument(other, 'theirs.md', 'y', []);
    const rows = recentFiles(ownerId, null, 50);
    expect(rows.map((r) => r.name)).toEqual(['mine.md']);
});

test('recentFiles：limit 生效', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', []);
    await uploadDocument(ownerId, 'b.md', 'y', []);
    expect(recentFiles(ownerId, null, 1).length).toBe(1);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/documents.test.ts -t recentFiles`
Expected: FAIL——模块加载报错 `does not provide an export named 'recentFiles'`

- [ ] **Step 3: 最小实现**

在 `apps/web/src/lib/server/documents.ts` 的 `listFolders` 函数结束（`}` 后）与 `// 目录树子项计数` 注释行之间插入：

```ts
// 「最近文档」视图：全局按 updated_at DESC 平铺该用户的文件（含 cold 归档行，只读元数据），
// keyset 分页：cursor 为上一页末行的 (updatedAt, id)，严格小于比较保证无漏无重（spec §5.1）。
// id 决胜仅为全序确定性：id 非单调，同毫秒内顺序无时间语义，不影响分页正确性。
export function recentFiles(
    ownerId: string,
    cursor: { updatedAt: number; id: string } | null,
    limit: number
): DocumentRow[] {
    const conds = [
        eq(schema.documents.ownerId, ownerId),
        eq(schema.documents.type, 'file')
    ];
    if (cursor) {
        conds.push(sql`(${schema.documents.updatedAt} < ${cursor.updatedAt} OR (${schema.documents.updatedAt} = ${cursor.updatedAt} AND ${schema.documents.id} < ${cursor.id}))`);
    }
    return db.select().from(schema.documents)
        .where(and(...conds))
        .orderBy(sql`${schema.documents.updatedAt} DESC`, sql`${schema.documents.id} DESC`)
        .limit(limit)
        .all();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/documents.test.ts`
Expected: PASS（全部，含既有用例）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/documents.ts apps/web/tests/documents.test.ts
git commit -m "feat(web): documents 增 recentFiles——全局 updated_at DESC keyset 分页查询"
```

---

### Task 2: 索引三处同步 + migration

**Files:**
- Modify: `apps/web/src/lib/server/db/schema.ts`（documents 表 index 配置 + 顶部 import）
- Modify: `apps/web/src/lib/server/db/index.ts`（`SCHEMA_SQL` 内追加一行）
- Generate: `apps/web/src/lib/server/db/migrations/0004_*.sql`（`db:generate` 产出）
- Modify: `apps/web/src/lib/server/documents.ts`（recentFiles cursor 谓词改 row-value，质量审查跟进）
- Modify: `apps/web/tests/documents.test.ts`（「仅文件」测试加非空断言防假绿）

- [ ] **Step 1: schema.ts 声明索引**

顶部 import 区（`from 'drizzle-orm/sqlite-core'` 那行之前）加：

```ts
import { sql } from 'drizzle-orm';
```

documents 表配置块（现有 `ownerParentNameTypeIdx` 行之后）追加一行：

```ts
    ownerTypeUpdatedIdx: index('documents_owner_type_updated_idx')
        .on(t.ownerId, t.type, sql`${t.updatedAt} DESC`, sql`${t.id} DESC`)
```

（类型依据：`IndexColumn = SQLiteColumn | SQL`——drizzle 0.36.4 sqlite-core 索引列无 `.desc()` 方法但接受 SQL 片段，已对照安装版 `.d.ts` 验证。）

- [ ] **Step 2: SCHEMA_SQL 运行时建表同步**

`apps/web/src/lib/server/db/index.ts` 的 `SCHEMA_SQL` 中，紧跟 `documents_owner_parent_name_type_idx` 那行（约 44 行）之后加：

```sql
CREATE INDEX IF NOT EXISTS documents_owner_type_updated_idx ON documents (owner_id, type, updated_at DESC, id DESC);
```

- [ ] **Step 3: 生成并检查 migration**

Run: `bun --filter remote-reader-web db:generate`
Then: `ls apps/web/src/lib/server/db/migrations/` 找到新生成的 `0004_*.sql`，`cat` 检查内容。

Expected: 包含 `CREATE INDEX \`documents_owner_type_updated_idx\`` 且 `updated_at`/`id` 列带 `DESC`。若生成器丢掉了 DESC（退化为全 ASC），手动改该 SQL 文件补上 DESC——SQLite 对等值前缀后的纯 DESC 排序反正可反向扫描，DESC 仅为语义显式化，手改无兼容风险。

- [ ] **Step 4: keyset 谓词改 row-value 形式（Task 1 质量审查跟进）**

质量审查实测：OR 形式谓词无法走索引范围 seek，深分页退化为从索引头逐行过滤（10 万行、cursor 深度 ~99990 时 15-20ms vs row-value 0.18ms，EXPLAIN 证实）；两种形式在 375 个含 tie 的 cursor 位置结果零差异（语义等价）。`documents.ts` 中 `recentFiles` 的 cursor 条件改为：

```ts
    if (cursor) {
        conds.push(sql`(${schema.documents.updatedAt}, ${schema.documents.id}) < (${cursor.updatedAt}, ${cursor.id})`);
    }
```

（SQLite row-value 需 3.15+，better-sqlite3 捆绑版 3.53 满足。）同时 `documents.test.ts` 的「recentFiles：仅文件，不含文件夹」测试追加一行非空断言：

```ts
    expect(rows.length).toBeGreaterThan(0);
```

跑 `bun run test apps/web/tests/documents.test.ts` 确认 42 条全绿（谓词语义等价，测试无需改期望）。

- [ ] **Step 5: 干净库上验证 migration 可应用（不动开发库）**

Run: `DATABASE_PATH=./data/tmp-mig-check.db bun --filter remote-reader-web db:migrate && node -e "const db=require('./apps/web/node_modules/better-sqlite3')('./apps/web/data/tmp-mig-check.db');console.log(db.prepare(\"SELECT sql FROM sqlite_master WHERE name='documents_owner_type_updated_idx'\").get())" && rm -f apps/web/data/tmp-mig-check.db*`

Expected: 打印出含 `updated_at DESC, id DESC` 的 CREATE INDEX 语句，随后清理临时库。

- [ ] **Step 6: 全量测试（确保 SCHEMA_SQL 与谓词变更无回归）**

Run: `bun run test`
Expected: 全绿（测试导入 db 模块时 `ensureSchema()` 会执行新 `CREATE INDEX IF NOT EXISTS`）

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/server/db/schema.ts apps/web/src/lib/server/db/index.ts apps/web/src/lib/server/db/migrations/ apps/web/src/lib/server/documents.ts apps/web/tests/documents.test.ts
git commit -m "feat(web): documents 增 owner_type_updated 索引 + keyset 谓词 row-value 化——三处同步，索引范围 seek"
```

---

### Task 3: 纯函数 `folderNamesOf` + `formatRelative`（TDD）

**Files:**
- Modify: `apps/web/src/lib/shared/folder-tree.ts`（末尾追加）
- Modify: `apps/web/tests/folder-tree.test.ts`（import + 末尾追加）
- Create: `apps/web/src/lib/shared/time.ts`
- Create: `apps/web/tests/format-relative.test.ts`

- [ ] **Step 1: 写 folderNamesOf 失败测试**

`apps/web/tests/folder-tree.test.ts` 第 2 行 import 改为：

```ts
import { ancestorsOf, visibleNodes, folderNamesOf, type TreeFolder } from '../src/lib/shared/folder-tree';
```

文件末尾追加：

```ts
// ===== folderNamesOf（「最近文档」面包屑，spec §6.4） =====

test('folderNamesOf 返回自顶向下路径名链（含 parentId 指向的文件夹）', () => {
    const byId = new Map(fixture().map((x) => [x.id, x]));
    expect(folderNamesOf(byId, 'c')).toEqual(['a', 'b', 'c']); // d 的面包屑
    expect(folderNamesOf(byId, 'a')).toEqual(['a']);           // b 的面包屑
});

test('folderNamesOf null 父 → 空链（根目录文档）', () => {
    expect(folderNamesOf(new Map(), null)).toEqual([]);
});

test('folderNamesOf 父缺失即止（脏数据安全）', () => {
    const byId = new Map([f('orphan', 'missing')].map((x) => [x.id, x]));
    expect(folderNamesOf(byId, 'orphan')).toEqual(['orphan']);
    expect(folderNamesOf(byId, 'missing')).toEqual([]);
});

test('folderNamesOf parentId 环不死循环', () => {
    const cyc = new Map([f('x', 'y'), f('y', 'x')].map((x) => [x.id, x]));
    expect(() => folderNamesOf(cyc, 'x')).not.toThrow();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/folder-tree.test.ts -t folderNamesOf`
Expected: FAIL——`does not provide an export named 'folderNamesOf'`

- [ ] **Step 3: 实现 folderNamesOf**

`apps/web/src/lib/shared/folder-tree.ts` 末尾追加：

```ts
// 面包屑：parentId 的祖先 folder 名链（自顶向下，含 parentId 指向的文件夹自身）；
// 父缺失即止（脏数据安全），环走 MAX_TREE_DEPTH 上限安全截断。组件应预建 Map 复用（避免每行 O(n) 重建）。
export function folderNamesOf(byId: Map<string, TreeFolder>, parentId: string | null): string[] {
    const out: string[] = [];
    let cursor = parentId;
    let depth = 0;
    while (cursor) {
        const node = byId.get(cursor);
        if (!node) break;
        if (depth++ > MAX_TREE_DEPTH) break;
        out.unshift(node.name);
        cursor = node.parentId;
    }
    return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/folder-tree.test.ts`
Expected: PASS（全部）

- [ ] **Step 5: 写 formatRelative 失败测试**

新建 `apps/web/tests/format-relative.test.ts`：

```ts
import { test, expect } from 'vitest';
import { formatRelative } from '../src/lib/shared/time';

const NOW = 1_700_000_000_000;

test('刚刚：diff < 60s', () => {
    expect(formatRelative(NOW - 59_000, NOW)).toBe('刚刚');
    expect(formatRelative(NOW, NOW)).toBe('刚刚');
});

test('分钟前：60s ≤ diff < 60m', () => {
    expect(formatRelative(NOW - 60_000, NOW)).toBe('1 分钟前');
    expect(formatRelative(NOW - 59 * 60_000, NOW)).toBe('59 分钟前');
});

test('小时前：60m ≤ diff < 24h', () => {
    expect(formatRelative(NOW - 60 * 60_000, NOW)).toBe('1 小时前');
    expect(formatRelative(NOW - 23 * 3_600_000, NOW)).toBe('23 小时前');
});

test('天前：24h ≤ diff < 7d', () => {
    expect(formatRelative(NOW - 24 * 3_600_000, NOW)).toBe('1 天前');
    expect(formatRelative(NOW - (7 * 86_400_000 - 1), NOW)).toBe('6 天前');
});

test('日期：diff ≥ 7d 显示 YYYY-MM-DD（本地时间构造，时区无关）', () => {
    const past = new Date(2024, 0, 5, 12, 0, 0).getTime(); // 本地 2024-01-05 正午
    const now = past + 8 * 86_400_000;
    expect(formatRelative(past, now)).toBe('2024-01-05');
});
```

- [ ] **Step 6: 跑测试确认失败**

Run: `bun run test apps/web/tests/format-relative.test.ts`
Expected: FAIL——`Cannot find module '../src/lib/shared/time'`

- [ ] **Step 7: 实现 formatRelative**

新建 `apps/web/src/lib/shared/time.ts`：

```ts
// 相对时间（spec §6.4）：分钟级粒度，直接 SSR 渲染——SSR→hydrate 时间差造成的
// 文本不一致概率可忽略且无害。now 参数仅为测试可确定性注入。
export function formatRelative(ts: number, now: number = Date.now()): string {
    const diff = now - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
    const d = new Date(ts);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}
```

- [ ] **Step 8: 跑测试确认通过 + Commit**

Run: `bun run test apps/web/tests/format-relative.test.ts apps/web/tests/folder-tree.test.ts`
Expected: PASS

```bash
git add apps/web/src/lib/shared/folder-tree.ts apps/web/tests/folder-tree.test.ts apps/web/src/lib/shared/time.ts apps/web/tests/format-relative.test.ts
git commit -m "feat(web): 面包屑 folderNamesOf + 相对时间 formatRelative 纯函数（含单测）"
```

---

### Task 4: `GET /api/recent` 端点（TDD）

**Files:**
- Create: `apps/web/src/routes/api/recent/+server.ts`
- Test: `apps/web/tests/recent-api.test.ts`（新建）

依赖：Task 1 的 `recentFiles`、Task 5 将建的 `RECENT_PAGE_SIZE`——本任务先用字面量 50，Task 5 统一替换为常量（见 Task 5 Step 3 的替换说明）。

- [ ] **Step 1: 写失败测试**

新建 `apps/web/tests/recent-api.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';
import { setDocTags } from '../src/lib/server/tags';

const { GET } = await import('../src/routes/api/recent/+server');

const TMP = `./data/test-recent-${Date.now().toString(36)}`;
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

function setUpdatedAt(id: string, ts: number): void {
    db.update(schema.documents).set({ updatedAt: ts }).where(eq(schema.documents.id, id)).run();
}

function call(userId: string | null, query = ''): Promise<Response> {
    return GET({
        locals: { user: userId ? { id: userId } : null },
        url: new URL(`http://localhost/api/recent${query}`)
    } as Parameters<typeof GET>[0]);
}

test('未登录 → 401', async () => {
    await expect(call(null)).rejects.toMatchObject({ status: 401 });
});

test('返回 updated_at DESC 列表且内嵌 tags', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setUpdatedAt(a.id, T);
    setUpdatedAt(b.id, T + 1);
    await setDocTags(ownerId, a.id, ['周报']);
    const r = await call(ownerId);
    expect(r.status).toBe(200);
    const body = await r.json() as { items: { name: string; tags: { name: string }[] }[] };
    expect(body.items.map((i) => i.name)).toEqual(['b.md', 'a.md']);
    expect(body.items.find((i) => i.name === 'a.md')!.tags.map((t) => t.name)).toEqual(['周报']);
});

test('before cursor：返回 cursor 之后（更旧）的行', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setUpdatedAt(a.id, T);
    setUpdatedAt(b.id, T - 10);
    const r = await call(ownerId, `?before=${T}_${a.id}`);
    const body = await r.json() as { items: { name: string }[] };
    expect(body.items.map((i) => i.name)).toEqual(['b.md']);
});

test('非法 before → 400', async () => {
    await expect(call(ownerId, '?before=abc')).rejects.toMatchObject({ status: 400 });
});

test('非法 limit → 400', async () => {
    await expect(call(ownerId, '?limit=abc')).rejects.toMatchObject({ status: 400 });
});

test('limit 生效：?limit=1 只返回 1 条', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', []);
    await uploadDocument(ownerId, 'b.md', 'y', []);
    const r = await call(ownerId, '?limit=1');
    const body = await r.json() as { items: unknown[] };
    expect(body.items.length).toBe(1);
});

test('owner 隔离：只返回自己的文档', async () => {
    const other = generateId();
    db.insert(schema.users).values({
        id: other, email: `t2-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    await uploadDocument(ownerId, 'mine.md', 'x', []);
    await uploadDocument(other, 'theirs.md', 'y', []);
    const r = await call(ownerId);
    const body = await r.json() as { items: { name: string }[] };
    expect(body.items.map((i) => i.name)).toEqual(['mine.md']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/recent-api.test.ts`
Expected: FAIL——`Cannot find '../src/routes/api/recent/+server'`（模块不存在）

- [ ] **Step 3: 实现端点**

新建 `apps/web/src/routes/api/recent/+server.ts`（错误风格照抄 `api/v1/documents/+server.ts`：`error()` 抛错、`json()` 返回）：

```ts
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { recentFiles } from '$server/documents';
import { listTagsForDocs } from '$server/tags';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 2000; // re-sync 深度上限（spec §5.3，与 §7 性能论证对齐）

export const GET: RequestHandler = async ({ locals, url }) => {
    if (!locals.user) error(401, 'unauthorized');

    let limit = DEFAULT_LIMIT;
    const rawLimit = url.searchParams.get('limit');
    if (rawLimit !== null) {
        if (!/^\d+$/.test(rawLimit)) error(400, 'invalid limit');
        limit = Math.min(Math.max(Number.parseInt(rawLimit, 10), 1), MAX_LIMIT);
    }

    // cursor 格式 <updatedAt>_<id>：id 是 UUID+base36（不含 _），分隔符安全（spec §5.3）
    let cursor: { updatedAt: number; id: string } | null = null;
    const rawBefore = url.searchParams.get('before');
    if (rawBefore !== null) {
        const sep = rawBefore.indexOf('_');
        const tsStr = sep > 0 ? rawBefore.slice(0, sep) : '';
        const id = sep > 0 ? rawBefore.slice(sep + 1) : '';
        if (!/^\d+$/.test(tsStr) || !id) error(400, 'invalid before');
        cursor = { updatedAt: Number.parseInt(tsStr, 10), id };
    }

    const rows = recentFiles(locals.user.id, cursor, limit);
    const tagsByDoc = listTagsForDocs(rows.map((r) => r.id), locals.user.id);
    return json({ items: rows.map((r) => ({ ...r, tags: tagsByDoc.get(r.id) ?? [] })) });
};
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/recent-api.test.ts`
Expected: PASS（7 条全过）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/api/recent/+server.ts apps/web/tests/recent-api.test.ts
git commit -m "feat(web): GET /api/recent——session 认证的最近文档端点（keyset cursor + 内嵌 tags）"
```

---

### Task 5: 共享契约 `RecentDoc` + load 视图分支（TDD）

**Files:**
- Create: `apps/web/src/lib/shared/recent.ts`
- Modify: `apps/web/src/routes/+page.server.ts`（load 函数整体替换；actions 不动）
- Modify: `apps/web/src/routes/api/recent/+server.ts`（DEFAULT_LIMIT 换成共享常量）
- Test: `apps/web/tests/file-manager.test.ts`（末尾追加）

- [ ] **Step 1: 建共享契约**

新建 `apps/web/src/lib/shared/recent.ts`：

```ts
// 「最近文档」视图的共享契约：页面 load 与 /api/recent 端点都产出该形状，RecentList 组件只认它（spec §5.3/§6.2）。
// 服务端实际返回 DocumentRow & { tags }（字段是超集，结构兼容本类型）；目录视图的 children 今天就这么跨边界。
export const RECENT_PAGE_SIZE = 50;

export type RecentDoc = {
    id: string;
    parentId: string | null;
    name: string;
    type: 'file' | 'folder';
    sizeBytes: number | null;
    createdAt: number;
    updatedAt: number;
    storageTier: 'hot' | 'cold';
    tags: { id: string; name: string }[];
};
```

- [ ] **Step 2: 写失败测试**

`apps/web/tests/file-manager.test.ts` 末尾追加：

```ts
// ===== load 视图分支（recent，spec §6.1） =====

function setUpdatedAt(id: string, ts: number): void {
    db.update(schema.documents).set({ updatedAt: ts }).where(eq(schema.documents.id, id)).run();
}

test('load：view=recent 返回全局 recent 且 children 空', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const a = await uploadDocument(ownerId, 'a.md', 'x', ['d1']);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setUpdatedAt(a.id, T);
    setUpdatedAt(b.id, T + 1);
    const data = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/?view=recent') } as any);
    expect((data as any).view).toBe('recent');
    expect((data as any).children).toEqual([]);
    expect((data as any).recent.map((r: any) => r.name)).toEqual(['b.md', 'a.md']);
});

test('load：view=recent 内嵌 tags', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    await invoke(mod.actions.setTags, ownerId, { id: a.id, tags: '周报' });
    const data = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/?view=recent') } as any);
    const item = (data as any).recent.find((r: any) => r.id === a.id);
    expect(item.tags.map((t: any) => t.name)).toEqual(['周报']);
});

test('load：缺省 view=dir，行为不变（children 正常、recent 空）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await uploadDocument(ownerId, 'a.md', 'x', []);
    const data = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/') } as any);
    expect((data as any).view).toBe('dir');
    expect((data as any).children.length).toBe(1);
    expect((data as any).recent).toEqual([]);
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun run test apps/web/tests/file-manager.test.ts -t "load："`
Expected: 前两条 FAIL（`data.view` undefined / `data.recent` undefined），第三条 FAIL（`view` undefined）

- [ ] **Step 4: 实现 load 分支**

`apps/web/src/routes/+page.server.ts` 的 load 函数整体替换为（import 区追加 `recentFiles` 到 documents 导入、新增 `import { RECENT_PAGE_SIZE } from '../lib/shared/recent';`——**相对路径，勿用 `$lib`**：本文件被 file-manager.test.ts 直调 import，vitest 无 `$lib` alias）：

```ts
export const load: PageServerLoad = async ({ locals, url }) => {
    if (!locals.user) redirect(302, '/login');
    const view = url.searchParams.get('view') === 'recent' ? 'recent' as const : 'dir' as const;
    // 公共数据：左树（folders/计数）+ 标签编辑（allTags）两视图都要（spec §6.1）
    const folders = listFolders(locals.user.id);
    const folderCounts = folderChildCounts(locals.user.id);
    const allTags = listTags(locals.user.id);
    if (view === 'recent') {
        const rows = recentFiles(locals.user.id, null, RECENT_PAGE_SIZE);
        const tagsByDoc = listTagsForDocs(rows.map((r) => r.id), locals.user.id);
        const recent = rows.map((r) => ({ ...r, tags: tagsByDoc.get(r.id) ?? [] }));
        return { view, children: [], folders, currentDir: null, tagsByDoc, allTags, folderCounts, recent };
    }
    const dir = url.searchParams.get('dir');
    const parentId = dir && dir.length > 0 ? dir : null;
    const children = listChildren(locals.user.id, parentId);
    const fileIds = children.filter((c) => c.type === 'file').map((c) => c.id);
    const tagsByDoc = listTagsForDocs(fileIds, locals.user.id);
    return { view, children, folders, currentDir: parentId, tagsByDoc, allTags, folderCounts, recent: [] };
};
```

同时调整 `apps/web/src/routes/api/recent/+server.ts` 三处（`MAX_LIMIT = 2000` 行保持不变）：① 删掉 `const DEFAULT_LIMIT = 50;` 一行；② `let limit = DEFAULT_LIMIT;` 改为 `let limit = RECENT_PAGE_SIZE;`；③ import 区加 `import { RECENT_PAGE_SIZE } from '../../../lib/shared/recent';`。**两处 server 文件 import 一律用相对路径、勿用 `$lib`**：根 vitest.config.ts 的 alias 只有 `$server`/`$shared`/`$components`，本文件与 `+page.server.ts` 都被测试 `await import()` 直调，`$lib` 在 vitest 下解析失败（Momus 审查实测确认）。

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run test apps/web/tests/file-manager.test.ts apps/web/tests/recent-api.test.ts`
Expected: PASS（两文件全部）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/shared/recent.ts apps/web/src/routes/+page.server.ts apps/web/src/routes/api/recent/+server.ts apps/web/tests/file-manager.test.ts
git commit -m "feat(web): load 增 view 分支——?view=recent 返回前 50 条最近文档（含 RecentDoc 共享契约）"
```

---

### Task 6: FolderTree 类型放宽 + RecentList 组件 + 页面接线

**Files:**
- Modify: `apps/web/src/lib/components/FolderTree.svelte`（仅一行类型）
- Create: `apps/web/src/lib/components/RecentList.svelte`
- Modify: `apps/web/src/routes/+page.svelte`（script 增量 + fm-head/fm-right 模板替换 + CSS 追加）

组件测试无先例（FolderTree 亦无），验证靠 svelte-check + Task 7 冒烟；纯逻辑已在 Task 3/4/5 覆盖。

- [ ] **Step 1: FolderTree currentId 移除解构默认值**

`apps/web/src/lib/components/FolderTree.svelte` 第 8 行：

```ts
        currentId,
```

（**必须移除默认值，而非只放宽 cast 类型**：第 8 行 `currentId = null as string | null` 是解构默认值——JS 语义下显式传入的 `undefined` 会命中默认值变回 `null`，recent 视图将误高亮根目录，恰好违背 spec §6.3。移除后：传 `null` = 根目录高亮、传 `undefined` = 无任何高亮；prop 类型注解 `currentId?: string | null` 本就含 `undefined`，唯一调用方 `+page.svelte` 始终显式传值，行为不受影响。模板 `currentId === null` 对 `undefined` 为 false 天然不高亮，祖先展开 effect 的 `if (!currentId)` 已兼容，模板零改动。）

- [ ] **Step 2: 新建 RecentList.svelte**

新建 `apps/web/src/lib/components/RecentList.svelte`（完整内容）：

```svelte
<script lang="ts">
    import { invalidateAll } from '$app/navigation';
    import type { RecentDoc } from '$lib/shared/recent';
    import { RECENT_PAGE_SIZE } from '$lib/shared/recent';
    import { folderNamesOf, type TreeFolder } from '$lib/shared/folder-tree';
    import { formatRelative } from '$lib/shared/time';

    let {
        initialRows,
        folderById,
        scrollRoot,
        movingId,
        onStartMove,
        onCancelMove
    }: {
        initialRows: RecentDoc[];
        folderById: Map<string, TreeFolder>;
        scrollRoot: HTMLElement | null;
        movingId: string | null;
        onStartMove: (id: string) => void;
        onCancelMove: () => void;
    } = $props();

    // 本地列表状态：进入 recent 视图时组件挂载、从此初始化；invalidateAll 不重建组件，
    // 故 rows 不被 load 重置——列表不缩回、滚动位置保留的关键（spec §6.2）。
    let rows = $state<RecentDoc[]>([...initialRows]);
    let hasMore = $state(initialRows.length >= RECENT_PAGE_SIZE);
    let loadingMore = $state(false);
    let loadError = $state(false);
    let resyncing = $state(false);
    let editingId = $state<string | null>(null);
    let renameValue = $state('');
    let taggingId = $state<string | null>(null);
    let tagInput = $state('');
    let sentinel = $state<HTMLElement | null>(null);

    const pathOf = (item: RecentDoc): string => folderNamesOf(folderById, item.parentId).join(' / ');

    // use: action 仅客户端挂载时执行（SSR 无真实 DOM），安全聚焦+全选（与页面同款）
    function autofocus(node: HTMLInputElement) {
        node.focus();
        node.select();
    }

    // SvelteKit form action 直调（与页面 pickTarget 的 move 同款做法）：成功返回 true
    async function submitAction(action: string, fields: Record<string, string>): Promise<boolean> {
        const fd = new FormData();
        for (const [k, v] of Object.entries(fields)) fd.append(k, v);
        const r = await fetch(`?/${action}`, { method: 'POST', body: fd });
        return r.ok;
    }

    function cursorOfLast(): string | null {
        const last = rows[rows.length - 1];
        return last ? `${last.updatedAt}_${last.id}` : null;
    }

    // 无限滚动追加（spec §6.2）；keyset 语义下按 id 去重防边界重复
    async function loadMore(): Promise<void> {
        if (loadingMore || !hasMore || resyncing) return;
        const before = cursorOfLast();
        if (!before) return;
        loadingMore = true;
        loadError = false;
        try {
            const r = await fetch(`/api/recent?before=${encodeURIComponent(before)}`);
            if (!r.ok) throw new Error(String(r.status));
            const data = await r.json() as { items: RecentDoc[] };
            const seen = new Set(rows.map((x) => x.id));
            rows.push(...data.items.filter((x) => !seen.has(x.id)));
            hasMore = data.items.length >= RECENT_PAGE_SIZE;
        } catch {
            loadError = true;
        } finally {
            loadingMore = false;
        }
    }

    // re-sync：按当前已加载深度整体重拉（spec §6.2 操作后刷新）；父组件经 bind:this 调用。
    // 网络失败降级 invalidateAll（列表缩回可接受）。
    export async function reSync(): Promise<void> {
        if (resyncing) return;
        resyncing = true;
        const limit = Math.max(RECENT_PAGE_SIZE, rows.length);
        try {
            const r = await fetch(`/api/recent?limit=${limit}`);
            if (!r.ok) throw new Error(String(r.status));
            const data = await r.json() as { items: RecentDoc[] };
            rows = data.items;
            hasMore = data.items.length >= limit;
        } catch {
            await invalidateAll();
        } finally {
            resyncing = false;
        }
    }

    function startRename(item: RecentDoc): void {
        editingId = item.id;
        renameValue = item.name;
    }

    async function doRename(id: string): Promise<void> {
        const name = renameValue.trim();
        if (!name) return;
        if (await submitAction('rename', { id, name })) {
            editingId = null;
            await reSync();
        }
        // 失败保持编辑态：与目录视图 enhance 失败同样不强制反馈，用户可重试或取消
    }

    async function doSetTags(id: string): Promise<void> {
        if (await submitAction('setTags', { id, tags: tagInput })) {
            taggingId = null;
            tagInput = '';
            await reSync();
        }
    }

    async function doDelete(item: RecentDoc): Promise<void> {
        if (!confirm('确认删除该文件？此操作不可恢复。')) return;
        if (await submitAction('delete', { id: item.id })) await reSync();
    }

    // 哨兵 observer：root 为右栏滚动容器，rootMargin 提前 600px 预载（spec §6.2）。
    // 依赖仅 scrollRoot/sentinel；loadMore 内部状态在异步回调里读，不进依赖。SSR 不执行。
    $effect(() => {
        const root = scrollRoot;
        const target = sentinel;
        if (!root || !target) return;
        const io = new IntersectionObserver((entries) => {
            if (entries.some((e) => e.isIntersecting)) void loadMore();
        }, { root, rootMargin: '600px' });
        io.observe(target);
        return () => io.disconnect();
    });
</script>

{#if rows.length === 0}
    <p class="muted empty">还没有文档，让 Agent 通过 MCP 上传吧。</p>
{:else}
    <ul class="items">
        {#each rows as item (item.id)}
            <li class="item" class:editing={editingId === item.id}>
                {#if editingId === item.id}
                    <form class="rename-form" onsubmit={(e) => { e.preventDefault(); void doRename(item.id); }}>
                        <input value={renameValue} required use:autofocus
                            oninput={(e) => (renameValue = e.currentTarget.value)}
                            onkeydown={(e) => { if (e.key === 'Escape') editingId = null; }}>
                        <button type="submit" class="btn sm primary">保存</button>
                        <button type="button" class="btn sm" onclick={() => (editingId = null)}>取消</button>
                    </form>
                {:else}
                    <span class="name">
                        <a href="/d/{item.id}">📄 {item.name}</a>
                        {#if item.storageTier === 'cold'}<span class="chip-static cold-chip">☁️ 已归档</span>{/if}
                        {#if item.sizeBytes != null}<span class="size">{item.sizeBytes} B</span>{/if}
                    </span>
                    {#if pathOf(item)}
                        <span class="path" title={pathOf(item)}>{pathOf(item)}</span>
                    {/if}
                    <span class="time" title={new Date(item.updatedAt).toLocaleString()}>{formatRelative(item.updatedAt)}</span>
                    <span class="doc-tags">
                        {#each item.tags as tg (tg.id)}
                            <span class="chip-static">{tg.name}</span>
                        {/each}
                        {#if taggingId === item.id}
                            <form class="tag-form" onsubmit={(e) => { e.preventDefault(); void doSetTags(item.id); }}>
                                <input value={tagInput} placeholder="逗号分隔，如 周报, api" use:autofocus
                                    oninput={(e) => (tagInput = e.currentTarget.value)}
                                    onkeydown={(e) => { if (e.key === 'Escape') taggingId = null; }}>
                                <button type="submit" class="btn sm primary">保存</button>
                                <button type="button" class="btn sm" onclick={() => (taggingId = null)}>取消</button>
                            </form>
                        {:else}
                            <button class="icon-btn" title="编辑标签"
                                onclick={() => { taggingId = item.id; tagInput = item.tags.map((t) => t.name).join(', '); }}>🏷</button>
                        {/if}
                    </span>
                    <span class="actions">
                        <button class="icon-btn" title="重命名" onclick={() => startRename(item)}>✏</button>
                        {#if movingId === item.id}
                            <span class="hint">← 左树选目标</span>
                            <button class="btn sm" onclick={onCancelMove}>取消</button>
                        {:else}
                            <button class="icon-btn" title="移动到…" onclick={() => onStartMove(item.id)}>📂</button>
                        {/if}
                        <button class="icon-btn danger" title="删除" onclick={() => void doDelete(item)}>🗑</button>
                    </span>
                {/if}
            </li>
        {/each}
    </ul>
    {#if hasMore}
        <div class="sentinel" bind:this={sentinel} aria-hidden="true"></div>
    {/if}
    {#if loadingMore}<p class="muted">加载中…</p>{/if}
    {#if loadError}
        <p class="error">加载失败 <button class="link" onclick={() => void loadMore()}>点击重试</button></p>
    {/if}
{/if}

<style>
    /* 与目录视图行样式同源（Svelte 样式作用域隔离，组件各持一份） */
    .empty { padding: 2rem 0; }
    .items { list-style: none; padding: 0; margin: 1rem 0; }
    .item {
        display: flex; align-items: center; gap: 0.75rem;
        padding: 0.4rem 0.5rem; border-radius: 6px; border-bottom: 1px solid #eaecef;
    }
    .item:last-child { border-bottom: none; }
    .item:hover { background: #f6f8fa; }
    .item.editing { background: #ddf4ff; }

    .name { display: flex; align-items: baseline; gap: 0.5rem; flex: 1; min-width: 0; }
    .name a { color: #0969da; text-decoration: none; overflow-wrap: anywhere; }
    .name a:hover { text-decoration: underline; }
    .cold-chip { color: #57606a; font-weight: 400; }
    .size { color: #57606a; font-size: 0.8em; flex-shrink: 0; }

    .path {
        color: #57606a; font-size: 0.8em; flex-shrink: 1;
        max-width: 16rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    }
    .time { color: #57606a; font-size: 0.8em; flex-shrink: 0; font-variant-numeric: tabular-nums; }

    .actions { display: inline-flex; align-items: center; gap: 0.2rem; flex-shrink: 0; }

    .rename-form { display: flex; align-items: center; gap: 0.5rem; flex: 1; min-width: 0; }
    .rename-form input {
        flex: 1; min-width: 0; padding: 0.3rem 0.5rem;
        border: 1px solid #0969da; border-radius: 5px; font-size: 0.95rem; background: #fff;
    }
    .rename-form input:focus { outline: none; box-shadow: 0 0 0 2px rgba(9, 105, 218, 0.2); }

    .icon-btn {
        border: 1px solid transparent; background: transparent; cursor: pointer;
        padding: 0.35rem 0.5rem; border-radius: 5px; color: #57606a; font-size: 1rem; line-height: 1;
    }
    .icon-btn:hover { background: #fff; border-color: #d0d7de; color: #1f2328; }
    .icon-btn.danger:hover { color: #cf222e; border-color: #cf222e; }

    .btn {
        border: 1px solid #d0d7de; background: #fff; color: #1f2328; cursor: pointer;
        padding: 0.35rem 0.8rem; border-radius: 5px; font-size: 0.85rem; line-height: 1.2;
    }
    .btn.sm { padding: 0.3rem 0.65rem; }
    .btn.primary { background: #1f883d; color: #fff; border-color: #1f883d; }
    .btn.primary:hover { background: #1a7f37; }

    .doc-tags { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
    .chip-static { display: inline-block; padding: 0 0.4rem; background: #ddf4ff; color: #0969da; border-radius: 999px; font-size: 0.72rem; }
    .tag-form { display: inline-flex; align-items: center; gap: 0.3rem; }
    .tag-form input { padding: 0.25rem 0.5rem; border: 1px solid #0969da; border-radius: 5px; font-size: 0.8rem; min-width: 12rem; }

    .sentinel { height: 1px; }
    .muted { color: #57606a; }
    .error { color: #cf222e; font-size: 0.9em; }
    .hint { color: #2da44e; font-size: 0.85em; }
    .link { border: none; background: none; color: #0969da; cursor: pointer; padding: 0; }

    /* 窄屏：面包屑折行到第二行（spec §6.4） */
    @media (max-width: 768px) {
        .item { flex-wrap: wrap; }
        .path { order: 5; flex-basis: 100%; max-width: none; white-space: normal; }
    }
</style>
```

- [ ] **Step 3: +page.svelte script 增量**

`apps/web/src/routes/+page.svelte` script 区：

① import 区（`import FolderTree ...` 之后）加：

```ts
    import RecentList from '$components/RecentList.svelte';
```

② 状态与派生（`let rightPane = ...` 之后）加：

```ts
    let recentRef = $state<{ reSync: () => Promise<void> } | null>(null);
```

③ `treeFolders` 派生之后加：

```ts
    const view = $derived(data.view);
    // 面包屑用：folder id → TreeFolder 的 Map（load 已全量加载 folders，零额外查询，spec §6.4）
    const folderById = $derived(new Map(treeFolders.map((f) => [f.id, f] as const)));
```

④ `selectDir` 之后加视图切换助手（同路由 goto 组件不销毁，左树状态天然保留；右栏独立滚动容器须手动回顶，同 selectDir 注释）：

```ts
    async function switchView(url: string) {
        await goto(url, { keepFocus: true });
        rightPane?.scrollTo(0, 0);
    }
```

⑤ `pickTarget` 成功分支改为（追加 recent reSync——移动后该文档浮顶，列表按当前深度重拉；invalidateAll 负责刷左树）：

```ts
        if (r.ok) {
            movingId = null;
            moveError = null;
            await invalidateAll();
            await recentRef?.reSync();
        }
        else { moveError = '移动失败（目标无效或会造成环路），请重选目标或取消'; }
```

- [ ] **Step 4: +page.svelte 模板替换**

① `FolderTree` 调用的 `currentId={currentDir}` 改为（recent 视图无高亮，spec §6.3）：

```svelte
            currentId={view === 'recent' ? undefined : currentDir}
```

② `fm-head` 整块（`<div class="fm-head">` 到对应 `</div>`）替换为：

```svelte
        <div class="fm-head">
            <div class="fm-title">
                <h1>{view === 'recent' ? '最近文档' : currentDir ? '子目录' : '根目录'}</h1>
                <div class="segmented" role="group" aria-label="视图切换">
                    <button type="button" class="seg-btn" class:active={view !== 'recent'}
                        aria-pressed={view !== 'recent'} onclick={() => switchView('/')}>目录内容</button>
                    <button type="button" class="seg-btn" class:active={view === 'recent'}
                        aria-pressed={view === 'recent'} onclick={() => switchView('/?view=recent')}>最近文档</button>
                </div>
            </div>
            {#if view !== 'recent'}
                <form class="create-folder" method="POST" action="?/createFolder" use:enhance={() => async ({ result }) => { if (result.type === 'success') await invalidateAll(); }}>
                    <input name="name" placeholder="新文件夹名" required>
                    <button class="btn primary" type="submit">+ 新建文件夹</button>
                </form>
            {/if}
        </div>
```

③ 右栏内容（`</div>` of fm-head 之后、`</section>` 之前）包进视图分支——原 `{#if data.children.length === 0}...{/if}` 整块外面套：

```svelte
        {#if view === 'recent'}
            <RecentList
                bind:this={recentRef}
                initialRows={data.recent}
                folderById={folderById}
                scrollRoot={rightPane}
                movingId={movingId}
                onStartMove={startMove}
                onCancelMove={() => (movingId = null)}
            />
        {:else}
            {#if data.children.length === 0}
                <p class="muted empty">空空如也。让 Agent 通过 MCP 上传文档吧。</p>
            {:else}
                <ul class="items">
                    <!-- 原 {#each data.children ...} 整块原样保留，不动一行 -->
                </ul>
            {/if}
        {/if}
```

（执行时把现有 `{#if data.children.length === 0}` 到其 `{/if}` 的整段挪进 `{:else}` 分支，each 块内容零改动。）

- [ ] **Step 5: +page.svelte CSS 追加**

`<style>` 区（`.fm-head h1` 规则之后）追加：

```css
    .fm-title { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
    .segmented { display: inline-flex; border: 1px solid #d0d7de; border-radius: 6px; overflow: hidden; }
    .seg-btn {
        border: none; background: #f6f8fa; color: #1f2328; cursor: pointer;
        padding: 0.3rem 0.75rem; font-size: 0.85rem; line-height: 1.4;
    }
    .seg-btn + .seg-btn { border-left: 1px solid #d0d7de; }
    .seg-btn.active { background: #ddf4ff; color: #0969da; font-weight: 600; }
    .seg-btn:focus-visible { outline: 2px solid #0969da; outline-offset: -2px; }
```

- [ ] **Step 6: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 errors（svelte-check 覆盖 src + .svelte）

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/lib/components/FolderTree.svelte apps/web/src/lib/components/RecentList.svelte apps/web/src/routes/+page.svelte
git commit -m "feat(web): 最近文档视图接线——右栏分段切换/无限滚动/操作 re-sync，目录视图零改动"
```

---

### Task 7: 全量验证 + 冒烟 + 状态文档同步

**Files:**
- Modify: `docs/superpowers/specs/2026-09-08-recent-documents-view-design.md`（头部状态行）
- Modify: `CLAUDE.md`（当前状态段追加一句）

- [ ] **Step 1: 补 Task 3 质量审查的 3 条边界测试**

`apps/web/tests/format-relative.test.ts` 末尾追加：

```ts
test('未来时间戳（负 diff）→ 刚刚（时钟偏差优雅降级）', () => {
    expect(formatRelative(NOW + 5_000, NOW)).toBe('刚刚');
});

test('恰好 7d 整 → 日期分支', () => {
    expect(formatRelative(NOW - 7 * 86_400_000, NOW)).toBe(
        `${new Date(NOW - 7 * 86_400_000).getFullYear()}-` +
        `${String(new Date(NOW - 7 * 86_400_000).getMonth() + 1).padStart(2, '0')}-` +
        `${String(new Date(NOW - 7 * 86_400_000).getDate()).padStart(2, '0')}`
    );
});
```

`apps/web/tests/folder-tree.test.ts` 的「folderNamesOf parentId 环不死循环」测试追加断言：

```ts
    expect(folderNamesOf(cyc, 'x').length).toBeLessThanOrEqual(1001);
```

跑 `bun run test apps/web/tests/format-relative.test.ts apps/web/tests/folder-tree.test.ts` 确认全绿后提交：`git add -A apps/web/tests/format-relative.test.ts apps/web/tests/folder-tree.test.ts && git commit -m "test(web): 补边界用例——负 diff/整 7d/环截断长度（Task 3 审查跟进）"`

- [ ] **Step 2: 全量测试**

Run: `bun run test`
Expected: 全绿（存量 + 新增 ~20 条）

- [ ] **Step 3: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 errors

- [ ] **Step 4: 冒烟（dev server + curl）**

```bash
bun --filter remote-reader-web dev & DEV_PID=$!
sleep 5
curl -s -o /dev/null -w '%{http_code}\n' http://localhost:5173/api/recent      # 预期 401
curl -s -o /dev/null -w '%{http_code}\n' 'http://localhost:5173/?view=recent'  # 预期 302（未登录跳 /login）
kill $DEV_PID
```

Expected: 两行分别输出 `401`、`302`。

- [ ] **Step 5: （可选，若环境有浏览器工具）浏览器走查**

登录后：切「最近文档」→ 看到列表与面包屑/相对时间 → 上传新文档（另一终端 `scripts/seed-token.mjs` + curl 上传）→ 刷新浮顶 → 删除一行 → 列表不缩回、滚动位置保留 → 点左树目录 → 回目录视图。

- [ ] **Step 6: spec 状态翻转**

`docs/superpowers/specs/2026-09-08-recent-documents-view-design.md` 头部状态行改为：

```markdown
- **状态**: 已实现并 merge `master`（实现计划：`../plans/2026-09-08-recent-documents-view.md`）
```

- [ ] **Step 7: CLAUDE.md 当前状态同步**

`CLAUDE.md` 「当前状态」段第一段末尾（`259 单测 + svelte-check 0 错 + 桥 tsc 0 错 + Docker 构建冒烟全过。` 所在长段落之后）追加一句：

```markdown
**最近文档视图（2026-09-08）**：文件管理器右栏分段切换「目录内容 ⇄ 最近文档」（URL `?view=recent`，左树常驻）；全局 `updated_at DESC` 平铺（keyset 分页 + `GET /api/recent` session 端点 + 无限滚动哨兵）；行内操作后 re-sync 保持列表深度不缩回；面包屑 `folderNamesOf` + 相对时间 `formatRelative` 纯函数。spec：`docs/superpowers/specs/2026-09-08-recent-documents-view-design.md`。
```

（测试计数若有变化，顺带更新该段落的测试总数数字。）

- [ ] **Step 8: Commit**

```bash
git add docs/superpowers/specs/2026-09-08-recent-documents-view-design.md CLAUDE.md
git commit -m "docs: 最近文档视图实现状态同步——spec 翻转 + CLAUDE.md 当前状态"
```

---

## 验证总表（完成标准）

| 项 | 命令 | 预期 |
|---|---|---|
| 单测 | `bun run test` | 全绿（含新增 recentFiles/端点/load/纯函数用例） |
| 类型 | `bun --filter remote-reader-web check` | 0 errors |
| migration | Task 2 Step 4 | 干净库可应用，索引含 DESC |
| 冒烟 | Task 7 Step 3 | 401 / 302 |
| 回归 | 目录视图代码 diff | 仅 fm-head 模板与 FolderTree 移除一行默认值，each 块零改动 |
