# 标签与查找功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Remote Reader Web 增加用户手动标签（多对多）与跨目录查找（FTS5 全文 + 文件名 LIKE + 标签筛选，独立 `/search` 页），让用户能找到之前的文档。

**Architecture:** 新增 `tags` + `document_tags`（Drizzle 管理，多对多）+ `docs_fts`（FTS5 虚拟表，raw SQL 查询，靠 `ensureSchema` 建）。标签/搜索严格 per-owner。`documents.ts` 的 `deleteNode`/`uploadDocument`/`listChildren` 三个同步点改造。新增 `tags.ts`、`search.ts` server 模块、`/search` 路由；文件管理器 `/` 与查看页 `/d/[id]` 加标签编辑；`/settings/tags` 标签管理（后置）。

**Tech Stack:** SvelteKit · Drizzle ORM + better-sqlite3 (SQLite 3.53.2, FTS5 已实测可用) · vitest (node 运行时)

**关键约束（来自项目）：**
- **三处同步**：改表必须同步 `schema.ts` + `db/index.ts` 的 `SCHEMA_SQL` + drizzle migration，否则全新部署起不来（C1）。
- **运行时分工**：测试用 `bun run test`（vitest/node），dev 用 `bun --filter remote-reader-web dev`，类型检查 `bun --filter remote-reader-web check`。**不要用 `bun` 直接跑 .ts 测 better-sqlite3**（oven-sh/bun#4290）。
- **代码风格**：UTF-8、4 空格缩进、默认不加注释（仅解释"为什么"）。
- **FTS5 查询注入**：用户输入用双引号包裹成短语 + 转义内部双引号；LIKE 转义 `%`/`_`/`\`；snippet 用 `\x01`/`\x02` 占位 → 整体 HTML-escape → 替换为 `<mark>`（防 XSS）。

**Spec：** `docs/superpowers/specs/2026-08-04-tags-search-design.md`

---

## File Structure

**Create:**
- `apps/web/src/lib/server/tags.ts` — 标签 server 模块（listTags / listTagsForDoc(s) / setDocTags / renameTag / deleteTag）
- `apps/web/src/lib/server/search.ts` — 搜索模块（searchDocuments / getDocPath）
- `apps/web/tests/tags.test.ts` — 标签单测
- `apps/web/tests/search.test.ts` — 搜索单测
- `apps/web/src/routes/search/+page.server.ts` — 搜索页 load
- `apps/web/src/routes/search/+page.svelte` — 搜索页 UI
- `apps/web/src/routes/settings/tags/+page.server.ts` — 标签管理 load + actions
- `apps/web/src/routes/settings/tags/+page.svelte` — 标签管理 UI

**Modify:**
- `apps/web/src/lib/server/db/schema.ts` — 加 `tags` / `documentTags` 表
- `apps/web/src/lib/server/db/index.ts` — `SCHEMA_SQL` 加 3 个表 DDL + `ensureSchema` 后调 `backfillFts()`
- `apps/web/src/lib/server/documents.ts` — `deleteNode` 清 FTS、`uploadDocument` 同步 FTS、`listChildren` 排序、新增（或并入 search.ts）
- `apps/web/src/routes/+layout.svelte` — 顶部导航加搜索框
- `apps/web/src/routes/+page.server.ts` — load 返回标签映射 + `?/setTags` action
- `apps/web/src/routes/+page.svelte` — 列表项标签 chips + 编辑
- `apps/web/src/routes/d/[id]/+page.server.ts` — load 返回标签 + `?/setTags` action
- `apps/web/src/routes/d/[id]/+page.svelte` — 标签编辑区
- `apps/web/tests/documents.test.ts`（及其他现有测试）— `beforeEach` 补新表清理
- `apps/web/src/lib/server/db/migrations/meta/_journal.json` — 加 migration entry（由 `db:generate` 自动写）

---

## Task 1: 数据模型 — `tags` + `document_tags` 表（三处同步）

**Files:**
- Modify: `apps/web/src/lib/server/db/schema.ts`
- Modify: `apps/web/src/lib/server/db/index.ts`（`SCHEMA_SQL`）
- Generate: `apps/web/src/lib/server/db/migrations/0002_*.sql`（由 `db:generate`）

- [ ] **Step 1: `schema.ts` 追加两张表**

在 `shareLinks` 定义之后追加。文件顶部 import 改为 `import { sqliteTable, text, integer, index, unique, primaryKey } from 'drizzle-orm/sqlite-core';`

```ts
export const tags = sqliteTable('tags', {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull().references(() => users.id),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull()
}, (t) => ({
    ownerNameUnique: unique('tags_owner_name_unique').on(t.ownerId, t.name),
    ownerIdx: index('tags_owner_id_idx').on(t.ownerId)
}));

export const documentTags = sqliteTable('document_tags', {
    tagId: text('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
    documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' })
}, (t) => ({
    pk: primaryKey({ columns: [t.tagId, t.documentId] }),
    docIdx: index('document_tags_document_id_idx').on(t.documentId),
    tagIdx: index('document_tags_tag_id_idx').on(t.tagId)
}));
```

- [ ] **Step 2: `db/index.ts` 的 `SCHEMA_SQL` 追加两表 DDL**

在 `share_links_document_id_idx` 那条 `CREATE INDEX` 之后、闭合反引号之前追加：

```sql
CREATE TABLE IF NOT EXISTS tags (
    id text PRIMARY KEY NOT NULL,
    owner_id text NOT NULL,
    name text NOT NULL,
    created_at integer NOT NULL,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON UPDATE no action ON DELETE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS tags_owner_name_unique ON tags (owner_id, name);
CREATE INDEX IF NOT EXISTS tags_owner_id_idx ON tags (owner_id);
CREATE TABLE IF NOT EXISTS document_tags (
    tag_id text NOT NULL,
    document_id text NOT NULL,
    FOREIGN KEY (tag_id) REFERENCES tags(id) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON UPDATE no action ON DELETE cascade,
    PRIMARY KEY (tag_id, document_id)
);
CREATE INDEX IF NOT EXISTS document_tags_document_id_idx ON document_tags (document_id);
CREATE INDEX IF NOT EXISTS document_tags_tag_id_idx ON document_tags (tag_id);
```

- [ ] **Step 3: 生成 drizzle migration**

Run: `bun --filter remote-reader-web db:generate`
Expected: 生成 `migrations/0002_<auto>.sql`（含 `tags` / `document_tags` 的 `CREATE TABLE` + 索引），并更新 `meta/_journal.json` 与 `meta/0002_snapshot.json`。

- [ ] **Step 4: 人工核对 migration 与 SCHEMA_SQL 一致**

打开生成的 `0002_*.sql`，确认 `tags` / `document_tags` 的列定义、`UNIQUE(owner_id,name)`、两个索引、外键 `ON DELETE cascade` 与 Step 2 的 `SCHEMA_SQL` 完全一致。若 `db:generate` 把 `onDelete:'cascade'` 译成了 `no action`，手动改 migration SQL 为 `ON DELETE cascade`（保持与 SCHEMA_SQL 一致）。

- [ ] **Step 5: 写验证测试**

Create `apps/web/tests/tags-schema.test.ts`:

```ts
import { test, expect, beforeEach } from 'vitest';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { eq } from 'drizzle-orm';

let ownerId: string;
beforeEach(() => {
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId, email: `s-${Date.now()}@x.com`, passwordHash: 'x',
        role: 'member', createdAt: Date.now()
    }).run();
});

test('tags 表可写入并按 (owner_id,name) 唯一', () => {
    db.insert(schema.tags).values(
        { id: generateId(), ownerId, name: '周报', createdAt: Date.now() }
    ).run();
    expect(() => db.insert(schema.tags).values(
        { id: generateId(), ownerId, name: '周报', createdAt: Date.now() }
    ).run()).toThrow();
});

test('document_tags ON DELETE cascade：删 tag 自动清关联', () => {
    const tagId = generateId();
    const docId = generateId();
    db.insert(schema.documents).values({
        id: docId, ownerId, parentId: null, name: 'a.md', type: 'file',
        storagePath: '/tmp/x', contentHash: 'h', sizeBytes: 1,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    db.insert(schema.tags).values({ id: tagId, ownerId, name: 't1', createdAt: Date.now() }).run();
    db.insert(schema.documentTags).values({ tagId, documentId: docId }).run();
    expect(db.select().from(schema.documentTags).all().length).toBe(1);
    db.delete(schema.tags).where(eq(schema.tags.id, tagId)).run();
    expect(db.select().from(schema.documentTags).all().length).toBe(0);
});
```

- [ ] **Step 6: 跑测试验证通过**

Run: `bun run test apps/web/tests/tags-schema.test.ts`
Expected: 2 passed。

- [ ] **Step 7: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 errors。

- [ ] **Step 8: Commit**

```bash
git add apps/web/src/lib/server/db/schema.ts apps/web/src/lib/server/db/index.ts \
  apps/web/src/lib/server/db/migrations/ apps/web/tests/tags-schema.test.ts
git commit -m "feat(tags): 数据模型新增 tags + document_tags 表（三处同步）"
```

---

## Task 2: `docs_fts` FTS5 虚拟表 + 历史文档回填

**Files:**
- Modify: `apps/web/src/lib/server/db/index.ts`（`SCHEMA_SQL` 加 FTS5 DDL + `ensureSchema` 后调回填）
- Create: `apps/web/src/lib/server/fts.ts`（回填 + FTS 增删 helper）
- Test: `apps/web/tests/fts.test.ts`

> FTS5 虚拟表 Drizzle 不管理，**只在 `SCHEMA_SQL`（`ensureSchema` 用 `IF NOT EXISTS`）建表**，不写 drizzle migration。查询用 `sqlite.prepare`（raw SQL）。

- [ ] **Step 1: `SCHEMA_SQL` 追加 FTS5 建表**

在 `document_tags_tag_id_idx` 之后追加：

```sql
CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(doc_id UNINDEXED, name, content, tokenize = 'unicode61');
```

- [ ] **Step 2: 创建 `apps/web/src/lib/server/fts.ts`**

```ts
import { sqlite, db, schema } from './db';
import { eq, and, inArray, isNull, notInArray } from 'drizzle-orm';
import { readFile } from './storage';

export function indexDoc(docId: string, name: string, content: string): void {
    sqlite.prepare('DELETE FROM docs_fts WHERE doc_id = ?').run(docId);
    sqlite.prepare('INSERT INTO docs_fts (doc_id, name, content) VALUES (?, ?, ?)').run(docId, name, content);
}

export function unindexDocs(docIds: string[]): void {
    if (docIds.length === 0) return;
    const placeholders = docIds.map(() => '?').join(',');
    sqlite.prepare(`DELETE FROM docs_fts WHERE doc_id IN (${placeholders})`).run(...docIds);
}

// 启动时把历史 file 文档（FTS 缺失的）灌入索引。idempotent：按差集判定，重复启动不重复写。
export async function backfillFts(): Promise<void> {
    const files = db.select({ id: schema.documents.id, name: schema.documents.name, storagePath: schema.documents.storagePath })
        .from(schema.documents)
        .where(eq(schema.documents.type, 'file'))
        .all();
    if (files.length === 0) return;
    const indexedRows = sqlite.prepare('SELECT DISTINCT doc_id FROM docs_fts').all() as { doc_id: string }[];
    const indexed = new Set(indexedRows.map(r => r.doc_id));
    for (const f of files) {
        if (indexed.has(f.id) || !f.storagePath) continue;
        try {
            const content = await readFile(f.storagePath);
            indexDoc(f.id, f.name, content);
        } catch (e) {
            console.warn('[backfillFts] skip unreadable doc', f.id, e);
        }
    }
}
```

> `notInArray` 若 drizzle-orm 未导出则去掉该 import（本文件实际未用到，保留 `eq`/`inArray`/`isNull` 中用到的）。实际只用到 `eq`，import 精简为 `import { eq } from 'drizzle-orm';`。

- [ ] **Step 3: `db/index.ts` 在 `ensureSchema()` 之后调用回填**

在 `ensureSchema();` 那一行之后追加（注意 `backfillFts` 是 async，启动时不 await，失败不阻塞）：

```ts
ensureSchema();
// 历史文档回填 FTS（idempotent）。不 await：启动不阻塞；失败仅日志。
void import('./fts').then((m) => m.backfillFts()).catch((e) => console.warn('[backfillFts] failed', e));
```

> 用动态 import 避免循环依赖（`fts.ts` 反向 import `./db`）。

- [ ] **Step 4: 写测试**

Create `apps/web/tests/fts.test.ts`:

```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { indexDoc, unindexDocs, backfillFts } from '../src/lib/server/fts';
import { eq } from 'drizzle-orm';

let ownerId: string;
const TMP = `./data/test-fts-${Date.now().toString(36)}`;

beforeEach(() => {
    process.env.DATA_DIR = TMP;
    try { mkdirSync(TMP, { recursive: true }); } catch {}
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId, email: `f-${Date.now()}@x.com`, passwordHash: 'x',
        role: 'member', createdAt: Date.now()
    }).run();
});
afterEach(() => { try { rmSync(TMP, { recursive: true, force: true }); } catch {} });

test('indexDoc 写入后可被 MATCH 命中', () => {
    indexDoc('d1', 'weekly.md', '本周项目周报进展');
    const r = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"周报"') as { doc_id: string }[];
    expect(r[0].doc_id).toBe('d1');
});

test('unindexDocs 删除后不再命中', () => {
    indexDoc('d1', 'a.md', 'hello world');
    unindexDocs(['d1']);
    const r = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"hello"') as { doc_id: string }[];
    expect(r.length).toBe(0);
});

test('backfillFts 把历史文档（未经 uploadDocument）灌入索引', async () => {
    const path = `${TMP}/${ownerId}/old.md`;
    try { mkdirSync(`${TMP}/${ownerId}`, { recursive: true }); } catch {}
    writeFileSync(path, 'legacy content searchable');
    db.insert(schema.documents).values({
        id: 'old1', ownerId, parentId: null, name: 'old.md', type: 'file',
        storagePath: path, contentHash: 'h', sizeBytes: 10,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    await backfillFts();
    const r = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"legacy"') as { doc_id: string }[];
    expect(r[0].doc_id).toBe('old1');
});
```

- [ ] **Step 5: 跑测试**

Run: `bun run test apps/web/tests/fts.test.ts`
Expected: 3 passed。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/server/db/index.ts apps/web/src/lib/server/fts.ts apps/web/tests/fts.test.ts
git commit -m "feat(search): docs_fts FTS5 虚拟表 + 历史文档回填"
```

---

## Task 3: `tags.ts` 基础读函数

**Files:**
- Create: `apps/web/src/lib/server/tags.ts`
- Test: `apps/web/tests/tags.test.ts`

- [ ] **Step 1: 写失败测试（仅 listTags / listTagsForDoc / listTagsForDocs）**

Create `apps/web/tests/tags.test.ts`:

```ts
import { test, expect, beforeEach } from 'vitest';
import { db, schema } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { listTags, listTagsForDoc, listTagsForDocs } from '../src/lib/server/tags';
import { eq } from 'drizzle-orm';

let ownerId: string;
let docId: string;
const now = () => Date.now();

beforeEach(() => {
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    docId = generateId();
    db.insert(schema.users).values(
        { id: ownerId, email: `t-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: now() }
    ).run();
    db.insert(schema.documents).values({
        id: docId, ownerId, parentId: null, name: 'a.md', type: 'file',
        storagePath: '/tmp/a', contentHash: 'h', sizeBytes: 1, createdAt: now(), updatedAt: now()
    }).run();
});

function mkTag(name: string) {
    const id = generateId();
    db.insert(schema.tags).values({ id, ownerId, name, createdAt: now() }).run();
    db.insert(schema.documentTags).values({ tagId: id, documentId: docId }).run();
    return id;
}

test('listTags 返回 owner 全部标签（带 docCount，按名排序）', () => {
    mkTag('周报'); mkTag('api');
    const r = listTags(ownerId);
    expect(r.map(t => t.name)).toEqual(['api', '周报']);
    expect(r[0].docCount).toBe(1);
});

test('listTags 不返回其他 owner 的标签', () => {
    mkTag('mine');
    const other = generateId();
    db.insert(schema.users).values(
        { id: other, email: `o-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: now() }
    ).run();
    db.insert(schema.tags).values({ id: generateId(), ownerId: other, name: 'theirs', createdAt: now() }).run();
    expect(listTags(ownerId).map(t => t.name)).toEqual(['mine']);
});

test('listTagsForDoc 返回文档标签', () => {
    mkTag('x'); mkTag('y');
    expect(listTagsForDoc(docId, ownerId).map(t => t.name).sort()).toEqual(['x', 'y']);
});

test('listTagsForDocs 批量返回映射', () => {
    const doc2 = generateId();
    db.insert(schema.documents).values({
        id: doc2, ownerId, parentId: null, name: 'b.md', type: 'file',
        storagePath: '/tmp/b', contentHash: 'h', sizeBytes: 1, createdAt: now(), updatedAt: now()
    }).run();
    const t1 = mkTag('shared');
    const t2id = generateId();
    db.insert(schema.tags).values({ id: t2id, ownerId, name: 'only-b', createdAt: now() }).run();
    db.insert(schema.documentTags).values({ tagId: t2id, documentId: doc2 }).run();
    const map = listTagsForDocs([docId, doc2], ownerId);
    expect(map.get(docId)!.map(t => t.name)).toEqual(['shared']);
    expect(map.get(doc2)!.map(t => t.name).sort()).toEqual(['only-b', 'shared']);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun run test apps/web/tests/tags.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `tags.ts` 读函数**

Create `apps/web/src/lib/server/tags.ts`:

```ts
import { sqlite, db, schema } from './db';
import { generateId } from './auth';
import { eq, and } from 'drizzle-orm';

export type Tag = { id: string; name: string };

export function listTags(ownerId: string): (Tag & { docCount: number })[] {
    const rows = sqlite.prepare(`
        SELECT t.id, t.name, COUNT(dt.document_id) AS doc_count
        FROM tags t
        LEFT JOIN document_tags dt ON dt.tag_id = t.id
        WHERE t.owner_id = ?
        GROUP BY t.id, t.name
        ORDER BY t.name COLLATE NOCASE
    `).all(ownerId) as { id: string; name: string; doc_count: number }[];
    return rows.map(r => ({ id: r.id, name: r.name, docCount: r.doc_count }));
}

export function listTagsForDoc(docId: string, ownerId: string): Tag[] {
    return sqlite.prepare(`
        SELECT t.id, t.name FROM tags t
        JOIN document_tags dt ON dt.tag_id = t.id
        WHERE t.owner_id = ? AND dt.document_id = ?
        ORDER BY t.name COLLATE NOCASE
    `).all(ownerId, docId) as Tag[];
}

export function listTagsForDocs(docIds: string[], ownerId: string): Map<string, Tag[]> {
    const map = new Map<string, Tag[]>();
    if (docIds.length === 0) return map;
    const placeholders = docIds.map(() => '?').join(',');
    const rows = sqlite.prepare(`
        SELECT dt.document_id AS docId, t.id, t.name FROM tags t
        JOIN document_tags dt ON dt.tag_id = t.id
        WHERE t.owner_id = ? AND dt.document_id IN (${placeholders})
        ORDER BY t.name COLLATE NOCASE
    `).all(ownerId, ...docIds) as { docId: string; id: string; name: string }[];
    for (const r of rows) {
        if (!map.has(r.docId)) map.set(r.docId, []);
        map.get(r.docId)!.push({ id: r.id, name: r.name });
    }
    return map;
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun run test apps/web/tests/tags.test.ts`
Expected: 4 passed。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/tags.ts apps/web/tests/tags.test.ts
git commit -m "feat(tags): tags.ts 基础读函数 listTags/ForDoc/ForDocs"
```

---

## Task 4: `setDocTags` — 设置文档标签（★ Learning 开放决策点）

**Files:**
- Modify: `apps/web/src/lib/server/tags.ts`
- Test: `apps/web/tests/tags.test.ts`

> **★ Learning 开放决策点：** `setDocTags` 的**增量 diff 核心逻辑**（在事务里：新建缺失的 tag、对齐 document_tags 关联的增删）有多种合理写法。**执行时建议先请用户尝试写核心 5-10 行**（约束见下），再对照 Step 3 的参考实现。若用户不参与，直接用参考实现。
>
> 约束：① 事务内；② 幂等（同名 tag 复用，不重复建）；③ 同 owner 作用域；④ 先校验文档归属且为 file（否则抛 `SetTagsError('not_found')`）；⑤ 标签名经 sanitize（trim、≤32 字符、不含 `/`，非法名静默丢弃）；⑥ 不误删他人关联。

- [ ] **Step 1: 追加失败测试**

在 `tags.test.ts` 顶部 import 加 `setDocTags, SetTagsError`，并追加：

```ts
import { listTags, listTagsForDoc, listTagsForDocs, setDocTags, SetTagsError } from '../src/lib/server/tags';

test('setDocTags 新增不存在的标签并建立关联', () => {
    setDocTags(ownerId, docId, ['周报', 'api']);
    expect(listTagsForDoc(docId, ownerId).map(t => t.name).sort()).toEqual(['api', '周报']);
    expect(listTags(ownerId).length).toBe(2);
});

test('setDocTags 复用已存在的同名标签（不重复建 tag 行）', () => {
    setDocTags(ownerId, docId, ['x']);
    const doc2 = generateId();
    db.insert(schema.documents).values({
        id: doc2, ownerId, parentId: null, name: 'b.md', type: 'file',
        storagePath: '/tmp/b', contentHash: 'h', sizeBytes: 1, createdAt: now(), updatedAt: now()
    }).run();
    setDocTags(ownerId, doc2, ['x', 'y']);
    expect(listTags(ownerId).length).toBe(2);
    expect(listTagsForDoc(doc2, ownerId).map(t => t.name).sort()).toEqual(['x', 'y']);
});

test('setDocTags 移除不再列出的关联', () => {
    setDocTags(ownerId, docId, ['a', 'b']);
    setDocTags(ownerId, docId, ['a']);
    expect(listTagsForDoc(docId, ownerId).map(t => t.name)).toEqual(['a']);
});

test('setDocTags 传空数组移除全部关联（标签本身保留）', () => {
    setDocTags(ownerId, docId, ['a']);
    setDocTags(ownerId, docId, []);
    expect(listTagsForDoc(docId, ownerId)).toEqual([]);
    expect(listTags(ownerId).map(t => t.name)).toEqual(['a']);
});

test('setDocTags 去重 + 静默丢弃非法名', () => {
    setDocTags(ownerId, docId, ['ok', 'ok', '  ', 'a/b', 'ok']);
    expect(listTagsForDoc(docId, ownerId).map(t => t.name)).toEqual(['ok']);
});

test('setDocTags 非 owner 文档抛 not_found', () => {
    try {
        setDocTags('other', docId, ['x']);
        throw new Error('should have thrown');
    } catch (e) {
        expect(e).toBeInstanceOf(SetTagsError);
        expect((e as SetTagsError).code).toBe('not_found');
    }
});

test('setDocTags 文件夹抛 not_found（仅 file 可打标签）', () => {
    const folderId = generateId();
    db.insert(schema.documents).values({
        id: folderId, ownerId, parentId: null, name: 'fold', type: 'folder',
        storagePath: null, contentHash: null, sizeBytes: null, createdAt: now(), updatedAt: now()
    }).run();
    expect(() => setDocTags(ownerId, folderId, ['x'])).toThrow();
});
```

> `SetTagsError` 类在 Step 3 实现。

- [ ] **Step 2: 跑测试验证失败**

Run: `bun run test apps/web/tests/tags.test.ts`
Expected: FAIL（`setDocTags` 未导出）。

- [ ] **Step 3: 实现 `setDocTags` + sanitize（参考实现）**

在 `tags.ts` 追加：

```ts
const MAX_TAG_NAME = 32;

export class SetTagsError extends Error {
    code: 'not_found' | 'invalid';
    constructor(code: 'not_found' | 'invalid', message?: string) {
        super(message ?? code);
        this.code = code;
    }
}

function sanitizeTagName(raw: string): string | null {
    const n = raw.trim();
    if (!n || n.length > MAX_TAG_NAME || n.includes('/')) return null;
    return n;
}

function sanitizeNames(names: string[]): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const raw of names) {
        const n = sanitizeTagName(raw);
        if (n && !seen.has(n)) { seen.add(n); out.push(n); }
    }
    return out;
}

export function setDocTags(ownerId: string, docId: string, names: string[]): void {
    const doc = db.select().from(schema.documents)
        .where(and(eq(schema.documents.id, docId), eq(schema.documents.ownerId, ownerId)))
        .get();
    if (!doc || doc.type !== 'file') throw new SetTagsError('not_found');

    const clean = sanitizeNames(names);

    db.transaction((tx) => {
        const existing = tx.select().from(schema.tags).where(eq(schema.tags.ownerId, ownerId)).all();
        const idByName = new Map(existing.map(t => [t.name, t.id]));
        const targetIds: string[] = [];
        const now = Date.now();
        for (const name of clean) {
            let id = idByName.get(name);
            if (!id) {
                id = generateId();
                tx.insert(schema.tags).values({ id, ownerId, name, createdAt: now }).run();
                idByName.set(name, id);
            }
            targetIds.push(id);
        }
        const current = tx.select().from(schema.documentTags)
            .where(eq(schema.documentTags.documentId, docId)).all();
        const currentIds = new Set(current.map(l => l.tagId));
        const targetSet = new Set(targetIds);
        for (const id of currentIds) {
            if (!targetSet.has(id)) {
                tx.delete(schema.documentTags)
                    .where(and(eq(schema.documentTags.documentId, docId), eq(schema.documentTags.tagId, id))).run();
            }
        }
        for (const id of targetIds) {
            if (!currentIds.has(id)) {
                tx.insert(schema.documentTags).values({ tagId: id, documentId: docId }).run();
            }
        }
    });
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun run test apps/web/tests/tags.test.ts`
Expected: 全部 passed（含 Task 3 的 4 个 + 本任务 7 个）。

- [ ] **Step 5: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 errors。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/server/tags.ts apps/web/tests/tags.test.ts
git commit -m "feat(tags): setDocTags 增量设置文档标签（事务 + sanitize + 权限）"
```

---

## Task 5: `renameTag` + `deleteTag`

**Files:**
- Modify: `apps/web/src/lib/server/tags.ts`
- Test: `apps/web/tests/tags.test.ts`

- [ ] **Step 1: 追加失败测试**

import 加 `renameTag, deleteTag`：

```ts
test('renameTag 改名影响所有关联文档', () => {
    setDocTags(ownerId, docId, ['old']);
    expect(renameTag(ownerId, 'old', 'new').ok).toBe(true);
    expect(listTagsForDoc(docId, ownerId).map(t => t.name)).toEqual(['new']);
});

test('renameTag 目标名已存在返回 conflict', () => {
    setDocTags(ownerId, docId, ['a', 'b']);
    const r = renameTag(ownerId, 'a', 'b');
    expect(r.ok).toBe(false);
    expect(r.code).toBe('conflict');
});

test('renameTag 非法新名返回 invalid', () => {
    setDocTags(ownerId, docId, ['a']);
    expect(renameTag(ownerId, 'a', 'x/y').code).toBe('invalid');
});

test('renameTag 不存在的标签返回 not_found', () => {
    expect(renameTag(ownerId, 'nope', 'x').code).toBe('not_found');
});

test('deleteTag 删 tag 并级联清关联', () => {
    setDocTags(ownerId, docId, ['a', 'b']);
    deleteTag(ownerId, 'a');
    expect(listTagsForDoc(docId, ownerId).map(t => t.name)).toEqual(['b']);
    expect(listTags(ownerId).map(t => t.name)).toEqual(['b']);
});

test('deleteTag 其他 owner 的同名标签不受影响', () => {
    setDocTags(ownerId, docId, ['shared']);
    const other = generateId();
    db.insert(schema.users).values(
        { id: other, email: `o-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: now() }
    ).run();
    db.insert(schema.tags).values({ id: generateId(), ownerId: other, name: 'shared', createdAt: now() }).run();
    deleteTag(ownerId, 'shared');
    expect(listTags(ownerId).length).toBe(0);
    expect(db.select().from(schema.tags).where(eq(schema.tags.ownerId, other)).all().length).toBe(1);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun run test apps/web/tests/tags.test.ts`
Expected: FAIL（`renameTag`/`deleteTag` 未导出）。

- [ ] **Step 3: 实现**

在 `tags.ts` 追加：

```ts
export function renameTag(
    ownerId: string, oldName: string, newName: string
): { ok: boolean; code?: 'not_found' | 'conflict' | 'invalid' } {
    const clean = sanitizeTagName(newName);
    if (!clean) return { ok: false, code: 'invalid' };
    const tag = db.select().from(schema.tags)
        .where(and(eq(schema.tags.ownerId, ownerId), eq(schema.tags.name, oldName))).get();
    if (!tag) return { ok: false, code: 'not_found' };
    if (oldName === clean) return { ok: true };
    const dup = db.select().from(schema.tags)
        .where(and(eq(schema.tags.ownerId, ownerId), eq(schema.tags.name, clean))).get();
    if (dup) return { ok: false, code: 'conflict' };
    db.update(schema.tags).set({ name: clean }).where(eq(schema.tags.id, tag.id)).run();
    return { ok: true };
}

export function deleteTag(ownerId: string, name: string): void {
    const tag = db.select().from(schema.tags)
        .where(and(eq(schema.tags.ownerId, ownerId), eq(schema.tags.name, name))).get();
    if (!tag) return;
    db.delete(schema.tags).where(eq(schema.tags.id, tag.id)).run();
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun run test apps/web/tests/tags.test.ts`
Expected: 全部 passed。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/tags.ts apps/web/tests/tags.test.ts
git commit -m "feat(tags): renameTag / deleteTag（级联清关联 + owner 隔离）"
```

---

## Task 6: `deleteNode` 同步 — 清 FTS（document_tags 由 CASCADE 自动清）

**Files:**
- Modify: `apps/web/src/lib/server/documents.ts`
- Test: `apps/web/tests/documents.test.ts`

- [ ] **Step 1: 追加失败测试**

在 `documents.test.ts` import 加 `unindexDocs`（用于间接验证）实际不必；直接用 `sqlite` 查 FTS。import 加：
```ts
import { sqlite } from '../src/lib/server/db';
import { setDocTags } from '../src/lib/server/tags';
```
`beforeEach` 内追加清理（在 `db.delete(schema.users).run();` 之前）：
```ts
sqlite.prepare('DELETE FROM docs_fts').run();
db.delete(schema.documentTags).run();
db.delete(schema.tags).run();
```
追加测试：

```ts
test('deleteNode 删 file 同步清 docs_fts 与 document_tags', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'searchable text here', []);
    setDocTags(ownerId, r.id, ['t1']);
    const hit = () => (sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"searchable"') as { doc_id: string }[]);
    expect(hit().length).toBe(1);
    deleteNode(ownerId, r.id);
    expect(hit().length).toBe(0);
    expect(db.select().from(schema.documentTags).all().length).toBe(0);
});
```

> Task 7 会保证 `uploadDocument` 写入 FTS；若先跑此测试在 Task 7 前会因 FTS 未写入而 `hit().length` 为 0——故**执行顺序：Task 6 与 Task 7 可合并执行，或先 Task 7**。计划按编号顺序，但实现者注意：本测试依赖 `uploadDocument` 已写 FTS（Task 7）。若严格 TDD，把 Task 7 的 uploadDocument-FTS 实现先做，或在本测试里手动 `indexDoc`。最简：在本测试里 import `indexDoc` 直接灌一条，避免跨任务依赖：

替换上面测试的 FTS 写入为：
```ts
import { indexDoc } from '../src/lib/server/fts';
...
const r = await uploadDocument(ownerId, 'a.md', 'x', []);
indexDoc(r.id, 'a.md', 'searchable text here');
setDocTags(ownerId, r.id, ['t1']);
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun run test apps/web/tests/documents.test.ts -t "deleteNode 删 file 同步清"`
Expected: FAIL（删后 FTS 仍有行）。

- [ ] **Step 3: 改 `deleteNode` 事务**

`documents.ts` 顶部 import 加 `sqlite`：改 `import { db, schema } from './db';` 为 `import { db, schema, sqlite } from './db';`。
将 `db.transaction((tx) => { ... })` 块改为：

```ts
db.transaction((tx) => {
    tx.delete(schema.shareLinks).where(inArray(schema.shareLinks.documentId, subtreeIds)).run();
    // docs_fts 非 Drizzle 表，同连接同步执行故落在事务内
    const ph = subtreeIds.map(() => '?').join(',');
    sqlite.prepare(`DELETE FROM docs_fts WHERE doc_id IN (${ph})`).run(...subtreeIds);
    tx.delete(schema.documents).where(inArray(schema.documents.id, subtreeIds)).run();
});
```

> `document_tags` 由外键 `ON DELETE cascade` 自动清，无需显式删。

- [ ] **Step 4: 跑测试验证通过**

Run: `bun run test apps/web/tests/documents.test.ts`
Expected: 全部 passed（含原有 + 新增）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/documents.ts apps/web/tests/documents.test.ts
git commit -m "feat(search): deleteNode 删文档同步清 docs_fts（document_tags CASCADE）"
```

---

## Task 7: `uploadDocument` 同步 docs_fts（新建/覆盖写索引）

**Files:**
- Modify: `apps/web/src/lib/server/documents.ts`
- Test: `apps/web/tests/documents.test.ts`

- [ ] **Step 1: 追加失败测试**

```ts
test('uploadDocument 新建文档写入 FTS（可搜）', async () => {
    await uploadDocument(ownerId, 'a.md', 'unique_token_xyz', []);
    const r = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"unique_token_xyz"') as { doc_id: string }[];
    expect(r.length).toBe(1);
});

test('uploadDocument 覆盖更新 FTS（搜新内容、搜不到旧内容）', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'old_content_here', []);
    await uploadDocument(ownerId, 'a.md', 'new_content_here', []);
    const oldHit = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"old_content_here"') as { doc_id: string }[];
    const newHit = sqlite.prepare("SELECT doc_id FROM docs_fts WHERE docs_fts MATCH ?").all('"new_content_here"') as { doc_id: string }[];
    expect(oldHit.length).toBe(0);
    expect(newHit.length).toBe(1);
    expect(newHit[0].doc_id).toBe(r.id);
});

test('uploadDocument 相同内容（skip）不重复写 FTS', async () => {
    await uploadDocument(ownerId, 'a.md', 'same', []);
    const before = sqlite.prepare('SELECT COUNT(*) c FROM docs_fts').get() as { c: number };
    await uploadDocument(ownerId, 'a.md', 'same', []);
    const after = sqlite.prepare('SELECT COUNT(*) c FROM docs_fts').get() as { c: number };
    expect(after.c).toBe(before.c);
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun run test apps/web/tests/documents.test.ts -t "FTS"`
Expected: 新建/覆盖两个 FAIL（FTS 未写入）。

- [ ] **Step 3: 改 `uploadDocument`**

`documents.ts` 顶部 import 加 `import { indexDoc } from './fts';`。
- 覆盖分支（`if (existing) { ... db.update(...).run(); const url = ...; return ...; }`）在 `db.update(...).run();` 之后、`const url = await ensureShareUrl` 之前加：
```ts
indexDoc(existing.id, name, content);
```
- 新建分支（`db.insert(...).run();` 成功后、`const url = await ensureShareUrl(id);` 之前）加：
```ts
indexDoc(id, name, content);
```
- skip 分支（`existing.contentHash === contentHash`）不动 FTS。

- [ ] **Step 4: 跑测试验证通过**

Run: `bun run test apps/web/tests/documents.test.ts`
Expected: 全部 passed。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/documents.ts apps/web/tests/documents.test.ts
git commit -m "feat(search): uploadDocument 新建/覆盖同步 docs_fts"
```

---

## Task 8: `listChildren` 默认排序（folder 优先 + 更新时间倒序）

**Files:**
- Modify: `apps/web/src/lib/server/documents.ts`
- Test: `apps/web/tests/documents.test.ts`

- [ ] **Step 1: 追加失败测试**

```ts
test('listChildren 默认排序：folder 优先，同层按 updated_at 倒序', async () => {
    const old = await uploadDocument(ownerId, 'old.md', 'x', []);
    // 手动把 old 的 updatedAt 拨早
    db.update(schema.documents).set({ updatedAt: 1000 }).where(eq(schema.documents.id, old.id)).run();
    await uploadDocument(ownerId, 'new.md', 'y', ['afolder']);
    const children = listChildren(ownerId, null);
    // folder 优先
    expect(children[0].type).toBe('folder');
    // 文件按 updated_at 倒序：new 在 old 前
    const files = children.filter(c => c.type === 'file');
    expect(files[0].name).toBe('new.md');
    expect(files[1].name).toBe('old.md');
});
```

- [ ] **Step 2: 跑测试验证失败**

Run: `bun run test apps/web/tests/documents.test.ts -t "listChildren 默认排序"`
Expected: FAIL（当前无排序，顺序不确定）。

- [ ] **Step 3: 改 `listChildren`**

import 加 `sql`：`import { eq, and, isNull, inArray, ne, sql } from 'drizzle-orm';`
函数体加 `.orderBy(...)`：

```ts
export function listChildren(ownerId: string, parentId: string | null): DocumentRow[] {
    return db.select().from(schema.documents)
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            parentId === null
                ? isNull(schema.documents.parentId)
                : eq(schema.documents.parentId, parentId)
        ))
        .orderBy(
            sql`CASE WHEN ${schema.documents.type} = 'folder' THEN 0 ELSE 1 END`,
            sql`${schema.documents.updatedAt} DESC`
        )
        .all();
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun run test apps/web/tests/documents.test.ts`
Expected: 全部 passed。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/documents.ts apps/web/tests/documents.test.ts
git commit -m "feat(view): listChildren 默认排序（folder 优先 + 更新时间倒序）"
```

---

## Task 9: `searchDocuments` + `getDocPath`（★ Learning 开放决策点）

**Files:**
- Create: `apps/web/src/lib/server/search.ts`
- Test: `apps/web/tests/search.test.ts`

> **★ Learning 开放决策点：** `searchDocuments` 的**组合逻辑**（全文命中 ∪ 文件名命中 ∩ 标签筛选，去重、排序、构造 snippet）有多种合理写法（单条大 SQL vs 多步 JS 合并；排序权重）。**执行时建议先请用户尝试写核心 5-10 行**（约束见下），再对照参考实现。
>
> 约束：① 严格 owner 作用域；② `q` 经 `sanitizeFtsQuery`（双引号短语）喂 FTS、经 `escapeLike` 喂 LIKE；③ 标签多选取**交集**（HAVING count = tagNames.length）；④ 结果去重、上限 50；⑤ snippet 经 `\x01`/`\x02` 占位 → 整体 HTML-escape → 替换 `<mark>`（防 XSS）；⑥ `q` 与 `tagNames` 均空时返回 `[]`（空查询不列全部文档）。

- [ ] **Step 1: 写失败测试**

Create `apps/web/tests/search.test.ts`:

```ts
import { test, expect, beforeEach } from 'vitest';
import { db, schema } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';
import { setDocTags } from '../src/lib/server/tags';
import { searchDocuments, getDocPath } from '../src/lib/server/search';
import { sqlite } from '../src/lib/server/db';
import { eq } from 'drizzle-orm';

let ownerId: string;
const now = () => Date.now();

beforeEach(() => {
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    db.insert(schema.users).values(
        { id: ownerId, email: `s-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: now() }
    ).run();
});

test('全文命中正文关键词', async () => {
    await uploadDocument(ownerId, 'a.md', '本周项目周报进展顺利', []);
    const r = searchDocuments(ownerId, '周报', []);
    expect(r.length).toBe(1);
    expect(r[0].doc.name).toBe('a.md');
    expect(r[0].snippet).toContain('<mark>');
});

test('文件名 LIKE 命中（正文无该词）', async () => {
    await uploadDocument(ownerId, 'meeting-notes.md', '普通内容', []);
    const r = searchDocuments(ownerId, 'meeting', []);
    expect(r.length).toBe(1);
    expect(r[0].doc.name).toBe('meeting-notes.md');
});

test('标签筛选（单标签）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    await uploadDocument(ownerId, 'b.md', 'y', []);
    setDocTags(ownerId, a.id, ['important']);
    const r = searchDocuments(ownerId, '', ['important']);
    expect(r.length).toBe(1);
    expect(r[0].doc.name).toBe('a.md');
});

test('标签多选取交集', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    setDocTags(ownerId, a.id, ['t1', 't2']);
    setDocTags(ownerId, b.id, ['t1']);
    const r = searchDocuments(ownerId, '', ['t1', 't2']);
    expect(r.length).toBe(1);
    expect(r[0].doc.name).toBe('a.md');
});

test('关键词 + 标签组合（交集）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'unique_kw', []);
    await uploadDocument(ownerId, 'b.md', 'unique_kw', []);
    setDocTags(ownerId, a.id, ['vip']);
    const r = searchDocuments(ownerId, 'unique_kw', ['vip']);
    expect(r.length).toBe(1);
    expect(r[0].doc.name).toBe('a.md');
});

test('owner 隔离：搜不到他人文档', async () => {
    await uploadDocument(ownerId, 'a.md', 'secret_keyword_xyz', []);
    const r = searchDocuments('other-user', 'secret_keyword_xyz', []);
    expect(r.length).toBe(0);
});

test('空查询 + 空标签返回 []', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', []);
    expect(searchDocuments(ownerId, '', [])).toEqual([]);
});

test('FTS 特殊字符不报错（双引号、星号）', async () => {
    await uploadDocument(ownerId, 'a.md', 'hello world', []);
    expect(() => searchDocuments(ownerId, '"*AND', [])).not.toThrow();
    expect(searchDocuments(ownerId, '"*AND', []).length).toBe(0);
});

test('snippet 转义正文 HTML（防 XSS）', async () => {
    await uploadDocument(ownerId, 'a.md', '<script>x</script> 命中词', []);
    const r = searchDocuments(ownerId, '命中词', []);
    expect(r.length).toBe(1);
    expect(r[0].snippet).not.toContain('<script>');
    expect(r[0].snippet).toContain('&lt;script&gt;');
});

test('getDocPath 返回祖先链（根→父，不含文档本身）', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', ['rep', '2026']);
    const rep = db.select().from(schema.documents)
        .where(and(eq(schema.documents.name, 'rep'), eq(schema.documents.type, 'folder'))).get()!;
    const y2026 = db.select().from(schema.documents)
        .where(and(eq(schema.documents.name, '2026'), eq(schema.documents.type, 'folder'))).get()!;
    const path = getDocPath(ownerId, r.id);
    expect(path.map(p => p.name)).toEqual(['rep', '2026']);
});
```

> 文件顶部 `and` 未用则去掉；本测试用了 `and`（getDocPath 测试），保留 import `and, eq`。

- [ ] **Step 2: 跑测试验证失败**

Run: `bun run test apps/web/tests/search.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现 `search.ts`（参考实现）**

Create `apps/web/src/lib/server/search.ts`:

```ts
import { sqlite, db, schema } from './db';
import { eq, and } from 'drizzle-orm';
import { listTagsForDoc } from './tags';
import type { Tag } from './tags';

type DocumentRow = typeof schema.documents.$inferSelect;
const MAX_TREE_DEPTH = 1000;
const SEARCH_LIMIT = 50;

export type SearchResult = {
    doc: DocumentRow;
    path: DocumentRow[];
    tags: Tag[];
    snippet: string;
};

function sanitizeFtsQuery(q: string): string {
    const trimmed = q.slice(0, 100);
    const escaped = trimmed.replace(/"/g, '""');
    return `"${escaped}"`;
}

function escapeLike(s: string): string {
    return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// FTS highlight 用 \x01/\x02 占位；整体 escape 后再换回 <mark>，避免正文 HTML 注入。
function safeSnippet(raw: string): string {
    const escaped = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return escaped.replace(/\x01/g, '<mark>').replace(/\x02/g, '</mark>');
}

export function getDocPath(ownerId: string, docId: string): DocumentRow[] {
    const path: DocumentRow[] = [];
    const node = db.select().from(schema.documents)
        .where(and(eq(schema.documents.id, docId), eq(schema.documents.ownerId, ownerId)))
        .get();
    if (!node) return path;
    let cursor: string | null = node.parentId;
    let depth = 0;
    while (cursor) {
        if (depth++ > MAX_TREE_DEPTH) break;
        const p = db.select().from(schema.documents)
            .where(and(eq(schema.documents.id, cursor), eq(schema.documents.ownerId, ownerId)))
            .get();
        if (!p) break;
        path.unshift(p);
        cursor = p.parentId;
    }
    return path;
}

export function searchDocuments(ownerId: string, query: string, tagNames: string[]): SearchResult[] {
    const q = query.trim();
    const tags = tagNames.map(t => t.trim()).filter(Boolean);

    const snippetById = new Map<string, string>();
    const candidateIds = new Set<string>();

    if (q) {
        const ftsQ = sanitizeFtsQuery(q);
        let ftsRows: { id: string; raw: string }[] = [];
        try {
            ftsRows = sqlite.prepare(`
                SELECT d.id, highlight(docs_fts, 2, char(1), char(2)) AS raw
                FROM docs_fts JOIN documents d ON d.id = docs_fts.doc_id
                WHERE d.owner_id = ? AND docs_fts MATCH ?
                ORDER BY bm25(docs_fts)
                LIMIT ?
            `).all(ownerId, ftsQ, SEARCH_LIMIT) as { id: string; raw: string }[];
        } catch {
            ftsRows = [];
        }
        for (const r of ftsRows) {
            candidateIds.add(r.id);
            snippetById.set(r.id, safeSnippet(r.raw));
        }

        const like = `%${escapeLike(q)}%`;
        const likeRows = sqlite.prepare(`
            SELECT id FROM documents WHERE owner_id = ? AND name LIKE ? ESCAPE '\\'
        `).all(ownerId, like) as { id: string }[];
        for (const r of likeRows) {
            if (!candidateIds.has(r.id)) candidateIds.add(r.id);
        }
    }

    if (tags.length > 0) {
        const ph = tags.map(() => '?').join(',');
        const tagged = sqlite.prepare(`
            SELECT dt.document_id AS id FROM document_tags dt
            JOIN tags t ON t.id = dt.tag_id
            WHERE t.owner_id = ? AND t.name IN (${ph})
            GROUP BY dt.document_id
            HAVING COUNT(DISTINCT t.name) = ?
        `).all(ownerId, ...tags, tags.length) as { id: string }[];
        const taggedSet = new Set(tagged.map(r => r.id));
        if (q) {
            for (const id of [...candidateIds]) {
                if (!taggedSet.has(id)) candidateIds.delete(id);
            }
        } else {
            candidateIds.clear();
            for (const id of taggedSet) candidateIds.add(id);
        }
    }

    if (q === '' && tags.length === 0) return [];
    if (candidateIds.size === 0) return [];

    const ids = [...candidateIds];
    const ph = ids.map(() => '?').join(',');
    const docs = sqlite.prepare(`
        SELECT * FROM documents WHERE owner_id = ? AND id IN (${ph})
    `).all(ownerId, ...ids) as DocumentRow[];

    return docs.map(doc => ({
        doc,
        path: getDocPath(ownerId, doc.id),
        tags: listTagsForDoc(doc.id, ownerId),
        snippet: snippetById.get(doc.id) ?? ''
    })).slice(0, SEARCH_LIMIT);
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `bun run test apps/web/tests/search.test.ts`
Expected: 10 passed。

- [ ] **Step 5: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 errors。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/server/search.ts apps/web/tests/search.test.ts
git commit -m "feat(search): searchDocuments（FTS+LIKE+标签交集）+ getDocPath 面包屑"
```

---

## Task 10: `/search` 搜索页 + 顶部导航搜索框

**Files:**
- Create: `apps/web/src/routes/search/+page.server.ts`
- Create: `apps/web/src/routes/search/+page.svelte`
- Modify: `apps/web/src/routes/+layout.svelte`

- [ ] **Step 1: 搜索页 load**

Create `apps/web/src/routes/search/+page.server.ts`:

```ts
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { searchDocuments } from '$server/search';
import { listTags } from '$server/tags';

export const load: PageServerLoad = async ({ locals, url }) => {
    if (!locals.user) redirect(302, '/login');
    const q = url.searchParams.get('q') ?? '';
    const tag = url.searchParams.getAll('tag');
    const results = searchDocuments(locals.user.id, q, tag);
    return { results, q, selectedTags: tag, allTags: listTags(locals.user.id) };
};
```

- [ ] **Step 2: 搜索页 UI**

Create `apps/web/src/routes/search/+page.svelte`:

```svelte
<script lang="ts">
    let { data } = $props();
    const tags = $derived(data.allTags);
    function toggleTag(name: string): string[] {
        return data.selectedTags.includes(name)
            ? data.selectedTags.filter((t: string) => t !== name)
            : [...data.selectedTags, name];
    }
    function hrefFor(q: string, tagList: string[]): string {
        const p = new URLSearchParams();
        if (q) p.set('q', q);
        for (const t of tagList) p.append('tag', t);
        const s = p.toString();
        return s ? `/search?${s}` : '/search';
    }
</script>

<div class="search-page">
    <h1>查找文档</h1>
    <form method="GET" action="/search" class="search-form">
        <input name="q" value={data.q} placeholder="搜索文件名或正文…" autofocus>
        {#each data.selectedTags as t}
            <input type="hidden" name="tag" value={t}>
        {/each}
        <button type="submit" class="btn primary">搜索</button>
    </form>

    <aside class="tag-filter">
        <h2>标签筛选</h2>
        {#if tags.length === 0}
            <p class="muted">暂无标签</p>
        {:else}
            <div class="chips">
                {#each tags as t (t.id)}
                    <a class="chip" class:active={data.selectedTags.includes(t.name)}
                       href={hrefFor(data.q, toggleTag(t.name))}>
                        {t.name} <span class="count">{t.docCount}</span>
                    </a>
                {/each}
            </div>
        {/if}
    </aside>

    <section class="results">
        {#if !data.q && data.selectedTags.length === 0}
            <p class="muted">输入关键词或选择标签开始查找。</p>
        {:else if data.results.length === 0}
            <p class="muted">没有匹配的文档。</p>
        {:else}
            <ul>
                {#each data.results as r (r.doc.id)}
                    <li>
                        <a class="title" href="/d/{r.doc.id}">📄 {r.doc.name}</a>
                        {#if r.path.length > 0}
                            <span class="path">{r.path.map(p => p.name).join(' / ')}</span>
                        {/if}
                        {#if r.tags.length > 0}
                            <span class="tags">{#each r.tags as t}<span class="chip-static">{t.name}</span>{/each}</span>
                        {/if}
                        {#if r.snippet}
                            <p class="snippet">{@html r.snippet}</p>
                        {/if}
                    </li>
                {/each}
            </ul>
        {/if}
    </section>
</div>

<style>
    .search-page { font-family: system-ui, sans-serif; padding: 1.5rem; max-width: 960px; margin: 0 auto; }
    h1 { font-size: 1.25rem; }
    .search-form { display: flex; gap: 0.5rem; margin: 1rem 0; }
    .search-form input { flex: 1; padding: 0.5rem 0.7rem; border: 1px solid #d0d7de; border-radius: 6px; font-size: 0.95rem; }
    .search-form input:focus { outline: none; border-color: #0969da; box-shadow: 0 0 0 2px rgba(9,105,218,0.2); }
    .btn { border: 1px solid #d0d7de; background: #fff; color: #1f2328; cursor: pointer; padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 0.85rem; }
    .btn.primary { background: #1f883d; color: #fff; border-color: #1f883d; }
    .tag-filter { margin: 1rem 0; padding: 0.75rem; background: #f6f8fa; border-radius: 6px; }
    .tag-filter h2 { font-size: 0.9rem; margin: 0 0 0.5rem; color: #57606a; }
    .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .chip { padding: 0.2rem 0.6rem; border: 1px solid #d0d7de; border-radius: 999px; text-decoration: none; color: #1f2328; font-size: 0.8rem; background: #fff; }
    .chip.active { background: #0969da; color: #fff; border-color: #0969da; }
    .chip .count { opacity: 0.7; font-size: 0.75rem; }
    .results ul { list-style: none; padding: 0; }
    .results li { padding: 0.6rem 0; border-bottom: 1px solid #eaecef; }
    .title { color: #0969da; text-decoration: none; font-weight: 500; }
    .title:hover { text-decoration: underline; }
    .path { color: #57606a; font-size: 0.8rem; margin-left: 0.5rem; }
    .tags { margin-left: 0.5rem; }
    .chip-static { display: inline-block; padding: 0 0.4rem; background: #ddf4ff; color: #0969da; border-radius: 999px; font-size: 0.72rem; margin-right: 0.2rem; }
    .snippet { margin: 0.3rem 0 0; color: #57606a; font-size: 0.85rem; }
    .snippet :global(mark) { background: #fff8c5; padding: 0 1px; }
    .muted { color: #57606a; }
</style>
```

> `{@html r.snippet}` 安全：snippet 已在 server 端经 `safeSnippet` 整体 escape，仅含受控 `<mark>`。

- [ ] **Step 3: 顶部导航加搜索框**

`+layout.svelte` 的 `<header class="topnav">` 内，在 `<a href="/">我的文档</a>` 之后插入：

```svelte
<form class="nav-search" method="GET" action="/search">
    <input name="q" placeholder="搜索文档…" aria-label="搜索文档">
</form>
```

`<style>` 内 `.topnav` 区追加：

```css
.topnav .nav-search { margin-left: 0.5rem; }
.topnav .nav-search input {
    padding: 0.3rem 0.6rem; border: 1px solid #d0d7de; border-radius: 5px;
    font-size: 0.85rem; width: 14rem;
}
```

- [ ] **Step 4: 手动验证（dev）**

Run: `bun --filter remote-reader-web dev`（另开终端）
打开 `http://localhost:5173`，登录，确认：顶部导航有搜索框；输入词回车跳 `/search?q=...`；点标签筛选；结果含路径/标签/snippet。
（dev 模式 better-sqlite3 可加载。验证后 Ctrl+C 关闭。）

- [ ] **Step 5: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 errors。

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/routes/search/ apps/web/src/routes/+layout.svelte
git commit -m "feat(search): /search 搜索页 + 顶部导航搜索框"
```

---

## Task 11: 文件管理器 `/` 标签 chips + `?/setTags` action

**Files:**
- Modify: `apps/web/src/routes/+page.server.ts`
- Modify: `apps/web/src/routes/+page.svelte`

- [ ] **Step 1: load 返回标签映射 + 新增 `setTags` action**

`+page.server.ts`：
- import 加 `import { listTagsForDocs, setDocTags, SetTagsError } from '$server/tags';`
- `load` 的 return 改为：

```ts
const children = listChildren(locals.user.id, parentId);
const folders = listFolders(locals.user.id);
const fileIds = children.filter(c => c.type === 'file').map(c => c.id);
const tagsByDoc = listTagsForDocs(fileIds, locals.user.id);
return { children, folders, currentDir: parentId, tagsByDoc, allTags: listTags(locals.user.id) };
```

- `actions` 末尾追加：

```ts
setTags: async ({ request, locals }) => {
    if (!locals.user) redirect(302, '/login');
    const form = await request.formData();
    const id = String(form.get('id') ?? '');
    const raw = String(form.get('tags') ?? '');
    if (!id) error(400, '参数缺失');
    const names = raw.split(',').map(s => s.trim()).filter(Boolean);
    for (const n of names) {
        const t = n.trim();
        if (!t || t.length > 32 || t.includes('/')) error(400, `标签名非法：${t}`);
    }
    try {
        setDocTags(locals.user.id, id, names);
    } catch (e) {
        if (e instanceof SetTagsError) error(404, '文档不存在或无权操作');
        throw e;
    }
    return { ok: true };
}
```

- [ ] **Step 2: 列表项显示标签 chips + 编辑入口**

`+page.svelte`：
- `<script>` 加 `let taggingId = $state<string | null>(null);` 和 `let tagInput = $state('');`
- 在 `{:else}`（非编辑重命名态）的 `<span class="name">...</span>` 之后、`<span class="actions">` 之前插入标签显示与编辑：

```svelte
{#if item.type === 'file'}
    <span class="doc-tags">
        {#each (data.tagsByDoc.get(item.id) ?? []) as tg (tg.id)}
            <span class="chip-static">{tg.name}</span>
        {/each}
        {#if taggingId === item.id}
            <form class="tag-form" method="POST" action="?/setTags"
                use:enhance={() => async ({ result }) => { if (result.type === 'success') { taggingId = null; tagInput = ''; await invalidateAll(); } }}>
                <input type="hidden" name="id" value={item.id}>
                <input name="tags" value={tagInput || (data.tagsByDoc.get(item.id) ?? []).map(t => t.name).join(', ')}
                    placeholder="逗号分隔，如 周报, api" use:autofocus
                    onkeydown={(e) => { if (e.key === 'Escape') { taggingId = null; } }}>
                <button type="submit" class="btn sm primary">保存</button>
                <button type="button" class="btn sm" onclick={() => (taggingId = null)}>取消</button>
            </form>
        {:else}
            <button class="icon-btn" title="编辑标签" onclick={() => { taggingId = item.id; tagInput = ''; }}>🏷</button>
        {/if}
    </span>
{/if}
```

- `<style>` 追加：

```css
.doc-tags { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }
.chip-static { display: inline-block; padding: 0 0.4rem; background: #ddf4ff; color: #0969da; border-radius: 999px; font-size: 0.72rem; }
.tag-form { display: inline-flex; align-items: center; gap: 0.3rem; }
.tag-form input { padding: 0.25rem 0.5rem; border: 1px solid #0969da; border-radius: 5px; font-size: 0.8rem; min-width: 12rem; }
```

- [ ] **Step 3: 手动验证**

`bun --filter remote-reader-web dev`，登录进 `/`，点文件旁 🏷 编辑标签，保存后 chip 出现；进 `/search` 能按该标签筛到。

- [ ] **Step 4: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 errors。

- [ ] **Step 5: 扩展 file-manager 测试（setTags action + 清表）**

`apps/web/tests/file-manager.test.ts`：

import 改为 `import { db, schema, sqlite } from '../src/lib/server/db';`。

`beforeEach` 在 `db.delete(schema.shareLinks).run();` 之前追加：

```ts
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
```

文件末尾追加 setTags action 测试（复用现有 `invoke` / `insertUser` helper）：

```ts
// ===== setTags =====

test('setTags：正常设置标签', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    await invoke(mod.actions.setTags, ownerId, { id: r.id, tags: '周报, api' });
    const data = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/') } as any);
    expect((data as any).tagsByDoc.get(r.id).map((t: any) => t.name).sort()).toEqual(['api', '周报']);
});

test('setTags：非法标签名 → 400', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    await expect(invoke(mod.actions.setTags, ownerId, { id: r.id, tags: 'a/b' })).rejects.toMatchObject({ status: 400 });
});

test('setTags：非 owner 文档 → 404', async () => {
    const ownerId = generateId();
    const other = generateId();
    insertUser(ownerId); insertUser(other);
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    await expect(invoke(mod.actions.setTags, other, { id: r.id, tags: 'x' })).rejects.toMatchObject({ status: 404 });
});
```

- [ ] **Step 6: 跑全量测试**

Run: `bun run test`
Expected: 全绿。

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/+page.server.ts apps/web/src/routes/+page.svelte apps/web/tests/file-manager.test.ts
git commit -m "feat(tags): 文件管理器列表标签 chips + ?/setTags action"
```

---

## Task 12: `/d/[id]` 查看页标签编辑 + load 扩展

**Files:**
- Modify: `apps/web/src/routes/d/[id]/+page.server.ts`
- Modify: `apps/web/src/routes/d/[id]/+page.svelte`

- [ ] **Step 1: load 返回标签 + setTags action**

`+page.server.ts`：
- import 加 `import { listTagsForDoc, setDocTags, SetTagsError } from '$server/tags';` 与 `import type { Actions } from './$types';`（若无）。
- `load` 的 return 改为：

```ts
const tags = listTagsForDoc(doc.id, locals.user.id);
return { title: doc.name, html, tags, updatedAt: doc.updatedAt, sizeBytes: doc.sizeBytes };
```

- 文件末尾追加 actions：

```ts
export const actions: Actions = {
    setTags: async ({ request, locals, params }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const raw = String(form.get('tags') ?? '');
        const names = raw.split(',').map(s => s.trim()).filter(Boolean);
        for (const n of names) {
            if (!n || n.length > 32 || n.includes('/')) error(400, `标签名非法：${n}`);
        }
        try {
            setDocTags(locals.user.id, params.id, names);
        } catch (e) {
            if (e instanceof SetTagsError) error(404, '文档不存在或无权操作');
            throw e;
        }
        return { ok: true };
    }
};
```

> `error` 与 `redirect` 已在文件顶部 import。

- [ ] **Step 2: 页面加标签编辑区**

`+page.svelte` 改为：

```svelte
<script lang="ts">
    import MarkdownViewer from '$components/MarkdownViewer.svelte';
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    let { data } = $props();
    let editing = $state(false);
    let input = $derived(
        editing ? (data.tags.map(t => t.name).join(', ')) : ''
    );
</script>

<svelte:head><title>{data.title}</title></svelte:head>

<a href="/" class="back">← 返回我的文档</a>

<div class="tag-bar">
    {#if !editing}
        {#each data.tags as t (t.id)}<span class="chip-static">{t.name}</span>{/each}
        <button class="btn sm" onclick={() => (editing = true)}>🏷 编辑标签</button>
    {:else}
        <form method="POST" action="?/setTags" use:enhance={() => async ({ result }) => {
            if (result.type === 'success') { editing = false; await invalidateAll(); }
        }}>
            <input name="tags" value={input} placeholder="逗号分隔" autofocus
                onkeydown={(e) => { if (e.key === 'Escape') editing = false; }}>
            <button type="submit" class="btn sm primary">保存</button>
            <button type="button" class="btn sm" onclick={() => (editing = false)}>取消</button>
        </form>
    {/if}
</div>

<MarkdownViewer html={data.html} />

<style>
    .back { display: inline-block; max-width: 760px; margin: 0 auto; padding: 1rem 2rem 0; color: #0969da; }
    .tag-bar { max-width: 760px; margin: 0 auto; padding: 0.5rem 2rem; display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
    .chip-static { display: inline-block; padding: 0 0.5rem; background: #ddf4ff; color: #0969da; border-radius: 999px; font-size: 0.78rem; }
    .btn { border: 1px solid #d0d7de; background: #fff; color: #1f2328; cursor: pointer; padding: 0.3rem 0.7rem; border-radius: 5px; font-size: 0.8rem; }
    .btn.sm { padding: 0.25rem 0.6rem; }
    .btn.primary { background: #1f883d; color: #fff; border-color: #1f883d; }
    .tag-bar input { padding: 0.25rem 0.5rem; border: 1px solid #0969da; border-radius: 5px; font-size: 0.82rem; min-width: 14rem; }
</style>
```

- [ ] **Step 3: 扩展 d-view 测试（load 返回 tags + 清表）**

`apps/web/tests/d-view.test.ts`：

import 改为 `import { db, schema, sqlite } from '../src/lib/server/db';`。

`beforeEach` 在 `db.delete(schema.shareLinks).run();` 之前追加：

```ts
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
```

文件末尾追加：

```ts
test('load 返回文档标签字段（数组）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const diskPath = join(TMP, ownerId, 'd.md');
    await writeFile(diskPath, '# x');
    const docId = insertDoc(ownerId, 'd.md', diskPath);
    const result = (await load(mkEvent(ownerId, docId))) as { tags: unknown[] };
    expect(Array.isArray(result.tags)).toBe(true);
    expect(result.tags.length).toBe(0);
});
```

- [ ] **Step 4: 类型检查 + 跑测试**

Run: `bun --filter remote-reader-web check && bun run test`
Expected: 0 errors + 全绿。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/d/[id]/ apps/web/tests/d-view.test.ts
git commit -m "feat(tags): /d/[id] 查看页标签编辑 + load 返回标签/元数据"
```

---

## Task 13: `/settings/tags` 标签管理页（后置）

**Files:**
- Create: `apps/web/src/routes/settings/tags/+page.server.ts`
- Create: `apps/web/src/routes/settings/tags/+page.svelte`
- Modify: `apps/web/src/routes/+layout.svelte`（设置菜单加入口）

- [ ] **Step 1: load + actions**

Create `apps/web/src/routes/settings/tags/+page.server.ts`:

```ts
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { listTags, renameTag, deleteTag } from '$server/tags';

export const load: PageServerLoad = async ({ locals }) => {
    if (!locals.user) redirect(302, '/login');
    return { tags: listTags(locals.user.id) };
};

export const actions: Actions = {
    rename: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const oldName = String(form.get('old') ?? '');
        const newName = String(form.get('name') ?? '').trim();
        if (!oldName || !newName) error(400, '参数缺失');
        const r = renameTag(locals.user.id, oldName, newName);
        if (!r.ok) {
            if (r.code === 'conflict') error(409, '同名标签已存在');
            if (r.code === 'invalid') error(400, '标签名非法');
            error(404, '标签不存在');
        }
        return { ok: true };
    },
    delete: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const name = String(form.get('name') ?? '');
        if (!name) error(400, '参数缺失');
        deleteTag(locals.user.id, name);
        return { ok: true };
    }
};
```

- [ ] **Step 2: UI（参考 `/settings/tokens` 风格）**

Create `apps/web/src/routes/settings/tags/+page.svelte`:

```svelte
<script lang="ts">
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    let { data } = $props();
    let editing = $state<string | null>(null);
</script>

<h1>标签管理</h1>
<table>
    <thead><tr><th>名称</th><th>文档数</th><th></th></tr></thead>
    <tbody>
        {#each data.tags as t (t.id)}
            <tr>
                <td>
                    {#if editing === t.name}
                        <form method="POST" action="?/rename" use:enhance={() => async ({ result }) => {
                            if (result.type === 'success') { editing = null; await invalidateAll(); }
                        }}>
                            <input type="hidden" name="old" value={t.name}>
                            <input name="name" value={t.name} autofocus>
                            <button type="submit">保存</button>
                            <button type="button" onclick={() => (editing = null)}>取消</button>
                        </form>
                    {:else}
                        {t.name}
                    {/if}
                </td>
                <td>{t.docCount}</td>
                <td>
                    <button onclick={() => (editing = t.name)}>重命名</button>
                    <form method="POST" action="?/delete" use:enhance={({ cancel }) => {
                        if (!confirm(`删除标签「${t.name}」？将移除所有文档的该标签关联。`)) { cancel(); return; }
                        return async ({ result }) => { if (result.type === 'success') await invalidateAll(); };
                    }}>
                        <input type="hidden" name="name" value={t.name}>
                        <button>删除</button>
                    </form>
                </td>
            </tr>
        {/each}
    </tbody>
</table>

<style>
    :global(body) { font-family: system-ui, sans-serif; padding: 1.5rem; }
    table { border-collapse: collapse; margin-top: 1rem; }
    th, td { border: 1px solid #d0d7de; padding: 0.4rem 0.8rem; text-align: left; }
    form { display: inline-flex; gap: 0.3rem; }
</style>
```

- [ ] **Step 3: 设置菜单加入口**

`+layout.svelte` 的 `<div class="menu">` 内，在 `<a href="/settings/shares">分享链接</a>` 之后加：

```svelte
<a href="/settings/tags">标签管理</a>
```

- [ ] **Step 4: 类型检查 + 跑测试 + 手动验证**

Run: `bun --filter remote-reader-web check && bun run test`
Expected: 0 errors + 全绿。
手动：dev 下进 `/settings/tags`，重命名/删除标签，回 `/search` 验证生效。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/settings/tags/ apps/web/src/routes/+layout.svelte
git commit -m "feat(tags): /settings/tags 标签管理页（重命名/删除）"
```

---

## Task 14: 收尾 — 现有测试 beforeEach 补清理 + 全量验证

**Files:**
- Modify: `apps/web/tests/upload-api.test.ts`、`share-view.test.ts`、`shares.test.ts`、`apitokens.test.ts`、`storage.test.ts`（以及其他所有 `beforeEach` 清表的测试）

> 目的：新表（`document_tags` / `tags` / `docs_fts`）加入后，**所有**共享同一 SQLite 的测试文件 `beforeEach` 必须清理它们，否则测试间污染（CLAUDE.md 多次强调）。Task 6/11/12 已改 documents/file-manager/d-view；本任务扫剩余文件。

- [ ] **Step 1: 找出所有清表的 beforeEach**

Run:
```bash
grep -rL "documentTags\|docs_fts" apps/web/tests/*.test.ts
```
列出尚未清理新表的测试文件。对每个文件的 `beforeEach`，在清 `documents`/`shareLinks` 附近追加：

```ts
sqlite.prepare('DELETE FROM docs_fts').run();
db.delete(schema.documentTags).run();
db.delete(schema.tags).run();
```

> 若该文件未 import `sqlite`，加 `import { db, schema, sqlite } from '../src/lib/server/db';`（按需调整现有 import）。`docs_fts` 用 raw `sqlite.prepare` 清（非 Drizzle 表）。

- [ ] **Step 2: 跑全量测试**

Run: `bun run test`
Expected: 全绿（212 + 本计划新增用例，无回归）。

- [ ] **Step 3: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 errors / 0 warnings。

- [ ] **Step 4: 生产构建冒烟**

Run:
```bash
bun run build
node apps/web/build/index.js &
sleep 2
curl -sf http://localhost:3000/api/health && echo OK
kill %1
```
Expected: 构建成功，`/api/health` 返回 200（确认 FTS5 虚拟表在 `ensureSchema` 正常建、回填不阻塞启动）。

- [ ] **Step 5: Commit**

```bash
git add apps/web/tests/
git commit -m "test: 现有测试 beforeEach 补 document_tags/tags/docs_fts 清理"
```

---

## 完成标准

- 标签：文件管理器与 `/d/[id]` 可打/移除标签；`/settings/tags` 可重命名/删除；per-owner 隔离。
- 查找：`/search` 支持关键词（正文+文件名）+ 标签筛选（多选交集），结果带路径/标签/snippet 高亮；历史文档可搜（回填）。
- 安全：MATCH/LIKE 注入防护、snippet XSS 防护、owner 隔离均有测试覆盖。
- `bun run test` 全绿、`svelte-check` 0 错、生产构建 + health 冒烟通过。
- 三处同步一致（schema.ts / SCHEMA_SQL / migration 0002）。
