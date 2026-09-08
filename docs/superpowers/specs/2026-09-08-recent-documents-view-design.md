# 「最近文档」平铺视图（Recent Documents View）设计

- **创建日期**: 2026-09-08
- **状态**: 设计定稿，待实现（brainstorming 协作产出，关键决策均经用户确认）
- **上游文档**: [Remote Reader 设计文档](./2026-07-18-remote-reader-design.md)（§3 架构 / §5 文件管理器）

---

## 1. 背景与问题

文件管理器目前只有目录树导航（左树 + 右栏当前目录子项列表），擅长「按位置找」，不擅长「按时间找」：Agent 持续产出文档时，用户想直接看到最近提交/更新的文档，而不是逐目录翻找。

补充现状事实：

| # | 事实 | 含义 |
|---|---|---|
| 1 | `listChildren` 无分页，全量返回当前目录子项 | 目录视图本次**不动**（精准修改） |
| 2 | `renameNode` / `moveNode` / 覆盖上传都更新 `updated_at`；`touchDocument` 明确只动 `last_viewed_at`（注释：「不动 updated_at 避免影响排序语义」） | `updated_at` 作排序口径与现有语义自洽：查看不冒泡，上传/改名/移动冒泡 |
| 3 | load 已全量加载 `folders`（左树用） | 面包屑可前端拼装，零额外查询 |
| 4 | 现有索引 `(owner_id, parent_id)` / `(owner_id, parent_id, name, type)` 均不覆盖「owner + type 过滤 + updated_at 排序」 | 需要新索引 |

## 2. 目标与非目标

### 2.1 目标

- 右栏新增「最近文档」视图：按 `updated_at DESC` 全局平铺该用户全部文件（跨目录、含冷归档）
- 左栏目录树常驻；右栏头部分段控件在「目录内容」/「最近文档」间切换，URL `?view=recent` 可刷新/分享
- 大量文档不卡顿：服务端 keyset 分页，首屏 50 条，滚动到底自动追加 50 条
- 每行保留全部现有操作（重命名 / 移动 / 删除 / 标签）与冷归档 chip，并额外展示路径面包屑 + 相对更新时间

### 2.2 非目标（YAGNI，明确推迟）

- 时间筛选 / 日历分组 / 按周分节
- 前端虚拟滚动（keyset 分页已消除卡顿根源，且行内标签/chip 不定高会让虚拟列表复杂化）
- 修改目录视图任何现有行为（含其无分页现状）
- 文件夹进入最近列表（无「提交」语义；新建文件夹仍在目录视图完成）

## 3. 关键决策（均经用户确认）

| 决策点 | 结论 | 理由 |
|---|---|---|
| 排序口径 | `updated_at DESC`，`id DESC` 决胜 | 「最近有动静」直觉；与 `touchDocument` 既有语义一致（§1 表 #2） |
| 防卡顿策略 | 服务端 keyset 分页 + 无限滚动 | 卡顿根源是一次渲染上千行 DOM；分页后首屏恒 50 行。keyset 规避滚动中头部插入新文档导致的 offset 错位（漏行/重复行） |
| 模式共存 | 左树常驻 + 右栏分段控件 + URL `?view=recent` | 与 `?dir=` 导航模型一致；同路由 `goto` 组件不销毁，左树展开/滚动状态天然保留；移动操作（左树选目标）两种视图下都可用 |
| 追加数据通道 | 独立 session 认证端点 `GET /api/recent` | URL 不随滚动变化；不改页面 load 职责；不与 `/api/v1/*`（Bearer token 域）混淆 |
| 操作后刷新 | re-sync（按已加载深度重拉） | `invalidateAll` 会让列表缩回 50 条、滚动位置作废；re-sync 精确恢复且比乐观更新 + 合并逻辑简单一个量级 |

## 4. 架构与数据流

```mermaid
flowchart TD
    subgraph V["/ 文件管理器（左栏目录树常驻）"]
        SEG["右栏头部分段控件：目录内容 ⇄ 最近文档"]
        RL["RecentList.svelte（本地 rows 状态）"]
        OB["IntersectionObserver 哨兵<br/>rootMargin 600px 预载"]
        OPS["行内操作 ?/rename ?/move ?/delete ?/setTags"]
    end
    LOAD["+page.server.ts load<br/>?view=recent → 前 50 条（内嵌 tags）"]
    API["GET /api/recent?before=…&limit=…<br/>session 认证"]
    DB["recentFiles(owner, cursor, limit)<br/>索引 (owner_id, type, updated_at DESC, id DESC)"]

    SEG -->|goto 同路由导航| LOAD
    LOAD -->|进入视图时初始化| RL
    OB -->|滚到底自动触发| API
    OPS -->|成功后 re-sync：limit=max(50, 已加载条数)<br/>move 额外 invalidateAll 刷左树| API
    API --> DB
    API -->|追加（滚动）或整体替换（re-sync）| RL
```

**视图状态唯一来源是 URL**（`?view=recent` / `?dir=<id>`，缺省 = 目录视图根目录）。切换用 SvelteKit `goto`（同路由导航，组件实例保留）。SvelteKit form action `?/xxx` 会保留既有 search params（现有 `createFolder` 在 action 里读 `url.searchParams.get('dir')` 即依赖此行为），recent 视图下操作后停留在原视图。

## 5. 数据层

### 5.1 `recentFiles()`

`documents.ts` 新增：

```ts
export function recentFiles(
    ownerId: string,
    cursor: { updatedAt: number; id: string } | null,
    limit: number
): DocumentRow[]
```

- `WHERE owner_id = ? AND type = 'file'`（含 cold 归档行——列表只读元数据，不触内容）
- cursor 非空时追加 `（updated_at < cu）OR（updated_at = cu AND id < ci）`
- `ORDER BY updated_at DESC, id DESC LIMIT ?`
- **`id` 决胜仅为 keyset 全序确定性服务**：id 非单调（randomUUID + 时间戳后缀），同毫秒内顺序无时间语义，但不影响分页正确性（全序 + 严格比较即无漏无重）

### 5.2 索引（migration）

新增 `documents_owner_type_updated_idx ON documents(owner_id, type, updated_at DESC, id DESC)`，精确覆盖 §5.1 查询。实现方式（已对照安装版 drizzle 0.36.4 类型定义验证）：sqlite-core 索引列无 `.asc()/.desc()` 方法，但 `on()` 的参数类型 `IndexColumn = SQLiteColumn | SQL` 接受 SQL 片段——`sql`${t.updatedAt} DESC`` 写在 schema 里，`db:generate` 即可产出 DESC；即使生成器退化为全 ASC 列，SQLite 对等值前缀后的纯 DESC 排序可反向扫描同一索引，正确性不受影响。

### 5.3 端点 `GET /api/recent`

`src/routes/api/recent/+server.ts`：

- 认证：session（hooks.server.ts → `locals.user`，对 `+server.ts` 路由同样生效），未登录 401
- 参数：`before`（可选，格式 `<updatedAt>_<id>`，id 不含 `_` 故分隔符安全；首个 `_` 前为数字时间戳，非法 → 400）、`limit`（可选，默认 50，clamp 到 1..2000——上限即 re-sync 深度上限，与 §7 性能论证对齐）
- 响应：`{ items: RecentDoc[] }`，`RecentDoc = DocumentRow & { tags: Tag[] }`（tags 内嵌，客户端无需维护第二个 map；`listTagsForDocs` 批量查）
- `hasMore` 由客户端按 `items.length === limit` 判定（整除边界多一次空拉取即停，可接受）

## 6. 页面与组件

### 6.1 load 分支（`+page.server.ts`）

- 公共（两视图都要）：`folders`、`folderCounts`、`allTags`（左树 / 面包屑 / 标签编辑）
- `?view=recent`：`recent = recentFiles(owner, null, 50)` 内嵌 tags、`children = []`、`tagsByDoc` 为空 map
- 默认：现状不变

### 6.2 `RecentList.svelte`（新组件）

右栏 recent 视图内容。本地状态 `rows: RecentDoc[]`，生命周期：

| 时机 | 行为 |
|---|---|
| 进入 recent 视图（view 变化） | `rows = data.recent` |
| 哨兵进入视口且 hasMore 且非 loading | `GET /api/recent?before=<末行 cursor>`，结果追加 |
| delete / rename / setTags 成功 | re-sync：`GET /api/recent?limit=max(50, rows.length)` 整体替换（不 `invalidateAll`，滚动位置与深度保留；替换后 `hasMore` 按新结果重算，整除边界由空拉取自然终止） |
| move 成功 | re-sync + `invalidateAll()`（刷新左树 folders/计数；rows 为本地状态，load 重跑不重置它） |
| re-sync 网络失败 | 降级 `invalidateAll()`（列表缩回 50 条可接受） |

- IntersectionObserver：root = 右栏滚动容器（`.fm-right`），rootMargin `600px` 预载；`loading` 标志防重入；hasMore=false 后 disconnect；视图切换/rows 重置时重建（`$effect` 客户端建，SSR 安全）
- 追加失败：哨兵位置显示「加载失败 · 点击重试」
- 空状态：「还没有文档，让 Agent 通过 MCP 上传吧。」

### 6.3 `FolderTree.svelte` 微调

`currentId` 类型放宽为 `string | null | undefined`（默认仍 `null`）：recent 视图传 `undefined` → 无任何高亮。模板 `currentId === null` 对 `undefined` 为 false（根目录不再误高亮）、`f.id === currentId` 同理；祖先展开 effect 的 `if (!currentId)` 已天然兼容——**组件模板零改动，只放宽类型**。点左树任意目录 = `selectDir` = 切回目录视图（用户的主要「回程」路径，无需额外记忆原目录）。

### 6.4 行渲染与纯函数

recent 文件行：📄 名称（链接 `/d/<id>`）+ 路径面包屑（`a / b / c`，灰字小号）+ 相对更新时间 + 大小 + 冷档 chip + tags + 四操作（重命名/移动/删除/标签，复用现有 form action 与交互状态机）。窄屏（≤768px）面包屑与时间折行。

两个新纯函数（可独立单测）：

```ts
// folder-tree.ts：自顶向下祖先名链；父缺失即止（脏数据安全）
export function folderNamesOf(byId: Map<string, TreeFolder>, parentId: string | null): string[]
```

组件内 `$derived` 建 Map 一次复用（避免每行重建 O(n) Map）。相对时间 `formatRelative(ts)` 放 `$lib/shared/`（刚刚 / N 分钟前 / N 小时前 / N 天前 / YYYY-MM-DD）。相对时间直接 SSR 渲染：分钟级粒度下 SSR→hydrate 时间差造成的文本不一致概率可忽略且无害。

### 6.5 分段控件

右栏 `fm-head` 布局：`h1`（视图标题：根目录/子目录/最近文档）+ 分段控件（目录内容 | 最近文档，`aria-pressed` 标记 active）+ 新建文件夹表单（仅目录视图显示）。

## 7. 性能论证

| 环节 | 分析 |
|---|---|
| SQL | 新索引精确匹配，O(log n + limit)；SQLite 本地查询毫秒级 |
| 首屏 | SSR 恒 50 行 DOM；滚动按需 +50，DOM 量 = 用户已看深度 |
| 面包屑 | folder Map 建一次，每行 O(depth) |
| tags | `listTagsForDocs` 批量查，无 N+1 |
| re-sync | 上限 = 已加载行数；2000 行 ≈ 300KB JSON 元数据，本地网络毫秒级，可接受 |
| 左树 | `listFolders` 全量现状不变（已有行为，非本次范围） |

## 8. 安全

- 端点 session 认证；`recentFiles` 内建 owner 过滤，无越界面
- 只读元数据，不触文件内容 / share token / 磁盘
- 同源 fetch，CSP（report-only）无影响

## 9. 测试计划

| 层 | 用例 |
|---|---|
| `documents.test.ts` | `recentFiles`：排序（updated_at desc + id 决胜）/ cursor 排除自身与更新行 / owner 隔离 / 仅文件（folder 不出现）/ limit 生效 |
| `folder-tree.test.ts` | `folderNamesOf`：正常链 / 孤儿父即止 / null → `[]` |
| 新 `recent-api.test.ts` | 无 session 401 / 正常返回 + 内嵌 tags / `before` 生效 / 非法 `before` 400 / owner 隔离 |
| load 测试 | `view=recent` 返回 recent 且 children 空；缺省行为不变 |
| `formatRelative` | 各阈值边界（59s/60s/59m/60m/23h/24h/6d/7d/8d） |
| 存量 | 现有全部测试保持绿（目录视图零改动是回归保证） |

## 10. 实现清单（文件级）

1. `documents.ts`：`recentFiles()` + 单测
2. `schema.ts` + migration：`documents_owner_type_updated_idx`
3. `routes/api/recent/+server.ts` + 测试
4. `folder-tree.ts`：`folderNamesOf()` + 单测；`$lib/shared`：`formatRelative` + 单测
5. `+page.server.ts`：load 分支 + 测试
6. `FolderTree.svelte`：`currentId` 类型放宽
7. `RecentList.svelte`（新）+ `+page.svelte` 接线（分段控件 / 视图分支 / 操作后 re-sync）
8. 验证：svelte-check 0 错 + 全量测试绿 + 手动冒烟（上传→recent 浮顶→滚动加载→删除后 re-sync 不缩回）
