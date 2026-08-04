# Remote Reader 标签与查找功能 设计文档

- 日期：2026-08-04
- 状态：已与用户确认设计，待写实现计划
- 关联：主 spec `2026-07-18-remote-reader-design.md` §13（未来扩展：文档标签 / 全文搜索）、§15.3（待做）
- 技术前提已实测：`better-sqlite3`（SQLite 3.53.2）已启用 FTS5，`MATCH` / `highlight` / `bm25` 均可用（验证脚本见 §7.4）

## 1. 背景与目标

Remote Reader 子计划 1/2/3 已全部完成 merge `master`。当前用户文档只能通过文件管理器 `/` 按目录树浏览，**无任何标签、搜索、过滤、排序能力**（已对 `apps/web/src/` 与 `packages/shared/src/` 全量 grep 确认）。随着文档累积，用户难以"找到之前的文档"。

本功能落地主 spec §13 规划的两项扩展：

- **文档标签**：用户在 Web 端为文档打标签（多对多）。
- **全文搜索**：基于 SQLite FTS5，覆盖正文 + 文件名 + 标签。

### 1.1 成功标准

- 用户能在文件管理器列表项和 `/d/[id]` 查看页为文档增删标签。
- 用户能从顶部搜索框进入 `/search`，用关键词（正文/文件名）+ 标签筛选跨目录找到文档，结果带路径面包屑与正文高亮。
- 标签和搜索均严格限定在 owner 作用域内，不跨用户泄露。
- 历史文档（功能上线前已存在的）同样可被搜索（启动时回填 FTS5）。

## 2. 非目标（YAGNI，明确推迟）

- 标签颜色 / 图标 / 层级分组
- 文件夹打标签（仅文件类型 `type='file'` 可打标签；文件夹名仍参与搜索）
- 搜索结果分页（先设上限 50 条 + 提示"结果过多请细化"）
- 搜索历史 / 保存搜索 / 收藏
- Agent 经 MCP 上传时带 tags（用户决策：仅用户在 Web 手动打，不改 `upload_document` 工具 / 上传 API / shared 层）
- FTS5 之外的外部搜索引擎（Meilisearch 等）

## 3. 关键决策（用户拍板）

| # | 决策点 | 选定 | 理由 |
|---|---|---|---|
| 1 | 标签来源 | 仅用户在 Web 手动打 | 改动面最小，不动 Agent/MCP/上传 API/shared |
| 2 | 查找范围 | 标签 + 文件名 + 全文（FTS5） | 标签手动打、覆盖率不确定，全文搜索兜底 |
| 3 | 查找呈现 | 独立搜索页 `/search?q=&tag=` | 跨目录扁平查找与目录浏览分离，展示空间足 |
| 4 | 标签编辑位置 | 文件管理器 + `/d/[id]` 查看页都能改 | 浏览时与查看时均可编辑 |
| 5 | 整体方案 | 规范多对多标签表 + FTS5 存正文副本 | 标签可重命名/删除、按标签筛高效、搜索结果高亮 |

## 4. 数据模型

现有 `documents` 表字段（`apps/web/src/lib/server/db/schema.ts`）：`id`、`ownerId`、`parentId`、`name`、`type`('file'|'folder')、`storagePath`、`contentHash`、`sizeBytes`、`createdAt`、`updatedAt`。现有索引：`documents_owner_parent_idx(owner_id,parent_id)`、`documents_owner_parent_name_type_idx(owner_id,parent_id,name,type)`。

### 4.1 新增 `tags` 表（标签字典，per-owner）

```
tags
├─ id            text PRIMARY KEY (cuid)
├─ owner_id      text NOT NULL → users.id
├─ name          text NOT NULL                 ← 同 owner 下唯一
├─ created_at    integer NOT NULL (unix ms)
├─ UNIQUE(owner_id, name)
└─ INDEX(owner_id)
```

### 4.2 新增 `document_tags` 关联表（多对多）

```
document_tags
├─ tag_id        text NOT NULL → tags.id  ON DELETE CASCADE
├─ document_id   text NOT NULL → documents.id  ON DELETE CASCADE
├─ PRIMARY KEY (tag_id, document_id)
└─ INDEX(document_id)     ← 按文档取标签（列表页批量）
└─ INDEX(tag_id)          ← 按标签取文档（搜索筛选）
```

> 外键 `ON DELETE CASCADE`：删 tag 自动清关联；删 document 在 `deleteNode` 事务里也会显式清（与现有 `share_links` 级联模式一致，双保险）。`foreign_keys=ON` 已在 `db/index.ts` 开启。

### 4.3 新增 `docs_fts` FTS5 虚拟表

```sql
CREATE VIRTUAL TABLE docs_fts USING fts5(
    doc_id UNINDEXED,
    name,
    content,
    tokenize = 'unicode61'
);
```

- `doc_id UNINDEXED`：只存储不索引，用于 JOIN 回 `documents`。
- `name`：文件名（一并索引，支持按文件名全文匹配，与 §6 的 LIKE 互补）。
- `content`：markdown 正文副本（从 `storage_path` 读取后写入）。
- `tokenize = 'unicode61'`：对中文按 Unicode 字符切分，零配置；英文按词。

### 4.4 迁移「三处同步」（关键，极易漏改）

新增表必须在三处保持一致，否则全新部署（Docker）起不来或老部署升级失败：

1. `apps/web/src/lib/server/db/schema.ts` —— `tags` / `document_tags` 用 Drizzle `sqliteTable` 定义；`docs_fts` 是虚拟表，Drizzle 无一等支持，用 `sql\`\`` raw 导出建表语句常量（供查询时引用列名）。
2. `apps/web/src/lib/server/db/index.ts` 的 `SCHEMA_SQL` 字符串 —— 追加 `tags` / `document_tags` 的 `CREATE TABLE IF NOT EXISTS` + `docs_fts` 的 `CREATE VIRTUAL TABLE ... USING fts5`（注意 FTS5 不支持 `IF NOT EXISTS` 直到 SQLite 3.35；3.53.2 支持，可加 `IF NOT EXISTS`）。CLAUDE.md C1 注释明确要求此处同步。
3. `apps/web/src/lib/server/db/migrations/0002_tags_search.sql` —— 跑 `bun --filter remote-reader-web db:generate` 生成（FTS5 DDL Drizzle-kit 可能不识别，需手写补充 raw SQL 到该迁移文件）。

## 5. 标签功能

### 5.1 用户行为

- **打标签**：文件管理器列表项 / `/d/[id]` 查看页，输入框输入标签名回车添加；不存在的标签自动创建。
- **移除标签**：点标签 chip 上的 × 移除该文档的关联（标签本身保留，可能成孤儿，见 §5.4）。
- **重命名 / 删除标签**：`/settings/tags` 设置页统一管理（重命名影响所有关联文档；删除 = 移除所有关联 + 删 tag 行）。
- 作用域：per-owner，A、B 用户的同名标签互不可见。
- 标签名规则：非空、≤32 字符、去除首尾空格、禁 `/`（避免与路径混淆）、禁标签内分隔符。

### 5.2 server 模块（新增 `apps/web/src/lib/server/tags.ts`）

所有函数都校验/限定 `ownerId`。

```ts
listTags(ownerId: string): Tag[]                                    // owner 全部标签（带 doc_count）
listTagsForDoc(docId: string, ownerId: string): Tag[]               // 单文档标签
listTagsForDocs(docIds: string[], ownerId: string): Map<docId, Tag[]>  // 批量（列表页性能，一次查询）
setDocTags(ownerId: string, docId: string, names: string[]): void   // ★ 开放决策点（§14.1）
renameTag(ownerId: string, oldName: string, newName: string): { ok, code? }
deleteTag(ownerId: string, name: string): void                      // 删 tag + 级联清 document_tags
```

类型 `Tag = { id: string; name: string }`（doc_count 仅 listTags 聚合返回）。

### 5.3 权限

所有标签操作必须先确认目标文档属于该 owner（复用 `getOwnedDocument(id, ownerId)`，非 owner 返回 404 不泄露存在性，与现有 `/d/[id]` 一致）。

### 5.4 孤儿标签

移除某文档的标签关联后，若某 tag 不再被任何 `document_tags` 引用，是否立即删除？默认：**不立即删**（保留以便复用），由 `/settings/tags` 页显式删除或定期清理。避免频繁创建/删除同名标签导致 id 抖动。

## 6. 查找功能（`/search` 独立页）

### 6.1 入口

顶部导航栏（所有需登录页面的 layout）加搜索框，回车 `GET /search?q=...&tag=...`。

### 6.2 搜索范围（全部限定 owner）

- **全文**：FTS5 `MATCH` 匹配 `docs_fts.content` + `docs_fts.name`，`bm25` 相关度排序，`highlight` 高亮匹配片段。
- **文件名 / 文件夹名**：`documents.name LIKE` 模糊匹配（文件夹无正文，仅此路径）。
- **标签筛选**：侧栏点标签 chip（可多选，**交集 AND**——缩小范围），与关键词组合。

### 6.3 结果展示

每条结果：文件名（链接 `/d/[id]`）、所在目录路径面包屑（递归 `parentId`）、标签 chips、正文高亮 `snippet`。同一文档多维度命中只显示一次。

### 6.4 server 函数（新增于 `documents.ts` 或独立 `search.ts`）

```ts
searchDocuments(ownerId: string, query: string, tagNames: string[]): SearchResult[]
// SearchResult = { doc: DocumentRow, path: DocumentRow[]（祖先链）, tags: Tag[], snippet: string }
getDocPath(ownerId: string, docId: string): DocumentRow[]   // 祖先链（面包屑），递归 parentId 至根
```

`searchDocuments` 的组合逻辑（全文 ∪ 文件名 ∩ 标签筛选，去重、排序）是 §14.2 开放决策点。

### 6.5 空查询

`q` 与 `tag` 均空：显示 owner 全部标签供点选浏览（不返回全部文档，避免大列表）。

## 7. FTS5 实现细节

### 7.1 分词器

`unicode61`：中文按字、英文按词。实测 "周报" MATCH "周报" 命中。若后续需要中文按词，可换 `trigram`（SQLite 3.34+，支持子串匹配，索引更大）——v1 不用。

### 7.2 查询注入防护（安全关键）

FTS5 `MATCH` 表达式支持特殊语法（`*`、`AND/OR/NOT/NEAR`、`"`、`}`、列过滤 `name:`）。用户输入直接拼入会触发语法错误或非预期查询。防护：

- 把用户输入用双引号包裹成**短语**：`"<escaped>"`。
- 转义内部双引号：`"` → `""`（FTS5 双引号转义）。
- 经绑定参数传入：`WHERE docs_fts MATCH ?`，`?` = 构造好的短语字符串。`owner_id` 亦走绑定。

```sql
SELECT d.id, d.name, d.parent_id, d.updated_at,
       highlight(docs_fts, 2, '<mark>', '</mark>') AS snippet
FROM docs_fts
JOIN documents d ON d.id = docs_fts.doc_id
WHERE docs_fts MATCH ?        -- ? = '"用户输入转义后"'
  AND d.owner_id = ?
ORDER BY bm25(docs_fts)       -- 越小越相关
LIMIT 50;
```

> `highlight(docs_fts, 2, ...)` 的 `2` 是 `content` 列在 `(doc_id=0, name=1, content=2)` 中的索引。

### 7.3 LIKE 转义

文件名 LIKE 分支：用户输入的 `%` `_` `\` 需转义，并加 `ESCAPE '\'`，防通配符注入与意外匹配。

### 7.4 可用性验证脚本（已跑通）

```js
const D = require('better-sqlite3');
const db = new D(':memory:');
db.exec('CREATE VIRTUAL TABLE ft USING fts5(content)');
db.exec("INSERT INTO ft(rowid, content) VALUES (1,'hello world report')");
db.prepare("SELECT highlight(ft,0,'[',']') h FROM ft WHERE ft MATCH 'world'").all();
// => [{ h: 'hello [world] report' }]
```

`pragma_module_list` 含 `fts5`，`sqlite_version()` = 3.53.2。

## 8. 历史文档回填

FTS5 表建好后为空，功能上线前的老文档搜不到。migration 是静态 SQL、无法读磁盘文件，故回填在 **JS 运行时**做（`db/index.ts` 的 `ensureSchema()` 之后）：

1. 查 `documents` 中 `type='file'` 的 `id` 集合 `D`。
2. 查 `docs_fts.doc_id` 集合 `F`。
3. 差集 `D − F` 即待回填。
4. 对每个待回填文档，读 `storagePath` 内容，`INSERT INTO docs_fts(doc_id, name, content) VALUES (?, ?, ?)`。
5. idempotent：以差集判定，重复启动不重复写；缺文件的文档跳过（不阻塞启动）。

> 仅在启动时跑一次差集回填；后续新文档/覆盖由 `uploadDocument` 同步写 FTS5（§9）。

## 9. 现有代码同步点（防数据不一致）

| 现有函数 | 文件 | 改动 |
|---|---|---|
| `deleteNode` | `documents.ts` | 事务里追加 `DELETE FROM docs_fts WHERE doc_id = ?`（被删文档及子孙）+ `document_tags` 由外键 CASCADE 清 |
| `uploadDocument` | `documents.ts` | 覆盖（hash 变）时：先 `DELETE FROM docs_fts WHERE doc_id=?` 再插新内容；新建时插入 FTS5 |
| `listChildren` | `documents.ts` | 加 `ORDER BY type, updated_at DESC`（folder 优先 + 新近优先）；或新增 `listChildrenSorted` |

## 10. 路由与 UI 改动

### 10.1 新路由 `/search`

- `apps/web/src/routes/search/+page.server.ts` `load`：读 `url.searchParams` 的 `q` / `tag`，调 `searchDocuments`，返回 `{ results, allTags, q, selectedTags }`。
- `apps/web/src/routes/search/+page.svelte`：搜索框 + 标签筛选侧栏（owner 全部标签，可点多选）+ 结果列表（文件名、路径面包屑、标签 chips、`{@html}` 渲染 `<mark>` 高亮 snippet——snippet 经 FTS5 highlight 产出，需确认仅含 `<mark>` 标签后用 `{@html}`，或改用文本 + 自行切分高亮避免 XSS）。

### 10.2 顶部导航搜索框

在需登录页面的 layout 组件（如 `Header`/`Nav`，需探查确认位置）加 `<form action="/search" method="GET">` 搜索框。

### 10.3 文件管理器 `/`

- `+page.server.ts` `load`：`listTagsForDocs(children 的 id 列表, ownerId)` 一并返回标签映射。
- `+page.svelte`：列表项渲染标签 chips + 编辑入口；新增 `?/setTags` form action（调 `tags.ts` 的 `setDocTags`）。
- 排序：随 `listChildren` 改动生效。

### 10.4 `/d/[id]` 查看页

- `+page.server.ts` `load`：当前只返回 `{ title, html }`，扩展为 `{ title, html, tags, doc: { updatedAt, sizeBytes } }`（顺带补元数据展示）。
- `+page.svelte`：顶部加标签编辑区（chips + 输入添加 + × 移除）；新增 `?/setTags` action。

### 10.5 新设置页 `/settings/tags`（标签管理）

- 列出 owner 全部标签 + 关联文档数 + 重命名 / 删除按钮（form action）。
- 优先级低于核心闭环（打标签 + 搜索），可在核心闭环验证后补。

### 10.6 标签写入入口共享

两页（`/` 与 `/d/[id]`）的 `?/setTags` action 调同一 `tags.ts#setDocTags`（核心逻辑单点，action 仅做参数解析与权限校验样板）。

## 11. 安全

- 标签操作与搜索结果**严格 owner 作用域**：所有 SQL 带 `owner_id = ?`；FTS5 结果 JOIN `documents` 后过滤 owner。
- FTS5 MATCH 注入：§7.2 双引号短语包裹 + 转义。
- LIKE 通配符注入：§7.3 转义 `%` `_` `\`。
- 搜索结果 snippet XSS（关键）：FTS5 `highlight` 输出混有用户文档正文（markdown 原文，可能含 `<script>` 等），直接 `{@html}` 有 XSS 风险。**唯一采用方案**：`highlight(docs_fts, 2, '\x01', '\x02')` 用中性控制符占位（而非 `<mark>`）→ 对返回字符串整体 HTML-escape（`\x01`/`\x02` 不受 escape 影响）→ 再把 `\x01` 替换为 `<mark>`、`\x02` 替换为 `</mark>` → 最后 `{@html}`。效果：正文已被转义为纯文本，仅注入受控的 `<mark>` 标签，无 XSS。**严禁直接 `{@html}` 原始 highlight 输出。**
- 搜索框 `q` 渲染走 Svelte 默认 `{q}`（自动转义）。

## 12. 错误处理

- 标签名非法（空 / 超长 / 含 `/`）：400。
- 操作非 owner 文档的标签：404（不泄露存在性）。
- 标签重命名目标名已存在：409。
- FTS5 MATCH 语法异常（转义后理论上不会，但兜底）：try/catch，降级为空结果或仅 LIKE 分支，不 500。
- 历史回填时单文件读失败：跳过、记录日志，不阻塞启动。

## 13. 测试策略（vitest，node 运行时）

新增：
- `apps/web/tests/tags.test.ts`：`listTags` / `setDocTags`（增量 diff 正确性）/ `renameTag`（含 409）/ `deleteTag`（级联清关联）/ owner 隔离 / 孤儿保留策略。
- `apps/web/tests/search.test.ts`：FTS5 全文命中、文件名 LIKE、标签筛选（单/多/交集）、组合（q + tag）、owner 隔离（不搜到他人文档）、空查询、MATCH 特殊字符转义（`"`/`*`/`AND`）、snippet 高亮正确、上限 50。

扩展：
- `documents.test.ts`：`deleteNode` 清 `docs_fts` + `document_tags`；`uploadDocument` 覆盖更新 FTS5（搜不到旧内容、搜得到新内容）。
- `file-manager.test.ts`：列表标签 chips 展示、`?/setTags` action（正常 / 非法名 400 / 非 owner 404）。
- `d-view.test.ts`：`load` 返回 tags；`?/setTags` action。

清理：所有测试文件的 `beforeEach` 清表语句追加 `db.delete(schema.documentTags).run()`、`db.delete(schema.tags).run()`、`db.delete(docs_fts).run()`（FTS5 用 `DELETE FROM docs_fts`）。

回填测试：构造历史 file 文档（手动插入 documents 不经 uploadDocument），触发回填后可被 `searchDocuments` 命中。

## 14. 开放决策点（learning 模式，实现时请用户写 5-10 行）

### 14.1 `setDocTags(ownerId, docId, names)` 增量 diff

输入：owner、文档 id、目标标签名数组（已 sanitize）。事务内：新建不存在的 tag、对齐 `document_tags` 关联（增删）。约束：幂等、同 owner 作用域、不误删他人关联。函数骨架与上下文届时备好。

### 14.2 `searchDocuments(ownerId, query, tagNames)` 组合逻辑

全文命中（FTS5）∪ 文件名命中（LIKE）∩ 标签筛选（多标签交集），去重、按相关度排序、构造路径面包屑与 snippet。多条 SQL 合并 vs 单条大 SQL、排序权重，有多种合理做法。

## 15. 实现顺序（建议）

1. 数据模型：三处同步加表 + FTS5 DDL，migration 0002，`bun run db:generate` / `db:migrate` 验证。
2. FTS5 回填（启动时），历史文档可搜验证。
3. `tags.ts`（含 `setDocTags`，§14.1 请用户写）+ 单测。
4. `documents.ts` 同步点（deleteNode / uploadDocument / listChildren 排序）+ 单测。
5. `searchDocuments`（§14.2 请用户写）+ 单测。
6. `/search` 页 + 顶部搜索框。
7. 文件管理器 `/` 标签 chips + `?/setTags`。
8. `/d/[id]` 标签编辑 + load 扩展。
9. `/settings/tags` 管理（后置）。
10. 全量测试 + svelte-check + 生产冒烟。

## 16. 影响面与回滚

- 改动 `documents.ts`（核心模块）、`db/index.ts`（启动建表）、文件管理器与查看页（用户高频路径）。
- 风险点：三处同步漏改、FTS5 回填阻塞启动、snippet XSS、MATCH 注入。
- 回滚：功能独立于既有上传/查看主流程；标签/搜索失败不影响文档上传与 `/s/<token>` 查看。每步可独立 commit，出问题按 commit 回滚。
