# 审查后续修改安排（2026-09-14 修复批次之后）

> 依据：`docs/reviews/2026-09-14-project-review.md`（审查终稿）+ 2026-09-14 修复批次（16 个提交，`e0ea170`…`0a28d0d`，测试 387→418）。
> 本文供新会话接手：每项含触发条件、范围、验收标准。**动工前建议通读本文 §3 的新不变量清单——后续修改可能面临重新审查，破坏这些不变量会直接打回。**

## 1. 待做项（按触发条件分组，均未开工）

### 1.1 触发条件已定义、暂不动工

| # | 事项 | 触发条件 | 范围与做法 | 验收 |
|---|---|---|---|---|
| F-1 | A-1 第二步：`DocRow` 行容器抽取 | 下一个行级功能（如"复制分享链接"按钮）动工时 | 目录视图与 RecentList 的行容器（name/size/tags/path/time 列布局）合并为 `DocRow.svelte`，差异列用 snippet 留 slot；第一步产物（`InlineNameForm`/`InlineTagForm`/`RowActions`）已就位 | 两视图行为一致；svelte-check 0 错；Playwright 冒烟（复用 2026-09-14 批次的 13 项场景） |
| F-2 | A-4：双 lightbox 合并 | 出现第三个 viewer，或需统一调整手势/工具栏 | 抽 `ZoomOverlay.svelte`（bar + 五键 + 全屏切换）+ `panZoomGestures` 共享 action（缩放数学已在 `lib/shared/mermaid-zoom.ts`）；`lib/shared/focus-trap.ts` 的 Tab 圈定随之入组件 | 三 viewer 视觉/交互一致；Mermaid 拖动与 Table Ctrl+滚轮的差异行为保留为 prop |
| F-3 | A-6：`documents.ts` 拆分 | 下一个 documents 域功能（回收站/批量操作/多文档上传）动工时 | 按域拆 `db/queries.ts`（findNode/listChildren/recentFiles…）、`mutations.ts`（rename/move/delete）、`content-io.ts`（uploadDocument/readDocumentContent/tiering 集成），纯移动不改行为 | 移动前后 418 测试全绿；文件各 <250 行；import 路径批量替换无遗留 |
| F-4 | settings `RevealBox.svelte` | 第 5 个 settings 页出现时 | tokens/invites 的 reveal 盒 + `copyPlaintext` 收敛为组件；`.settings-page`/表格 CSS 进全局 | 四旧页替换后视觉零变化 |
| F-5 | recent 视图跨路由返回列表缩回 | 产品决定要"保持深度"时（当前为已备案取舍） | rows 深度记入 SvelteKit snapshot 或 sessionStorage，返回时恢复 + 滚动位置 | 滚动加载 200 条 → 进文档 → 返回：深度与位置保持 |

### 1.2 运营依赖（代码侧准备就绪、等外部条件）

- **CSP 转 enforcing**：需先收集线上 report-only 违规报告（`/api/csp-report`），确认 mermaid/katex 无误伤后收紧。改动点仅 `svelte.config.js`（`reportOnly` 字段去掉）。
- **spec §12 Phase 3**：远程 MCP server（Streamable HTTP 挂载同一套 `packages/shared` 工具函数）/ 多文档批量上传。属新特性，须先过设计 spec。

### 1.3 设计级（未立项）

- session 服务端撤销表 / 审计日志（审查报告备案项，涉及 schema 变更，先写设计）。

## 2. 已知非问题（复审时不要重复报）

- 3 处 `autofocus` a11y 警告（d/[id]、search、settings/tags）：有意 UX，已备案。
- recent 视图跨路由返回缩回：见 F-5，产品取舍。
- dev 环境 vite 不加载仓库根 `.env`：已知存量行为（CLAUDE.md 邀请码节有记录）。
- Svelte 5 水合完成前的点击会被丢弃：框架行为，生产水合快得多；Playwright 测试须在交互前留稳定窗（约 1s）。

## 3. 本次修复批次引入的新不变量（复审红线）

后续任何改动若触碰以下区域，须保持不变量并在 PR/commit 中说明：

1. **唯一索引与上传外壳重试**：`documents_owner_parent_name_type_uniq`（COALESCE 表达式索引）三处同步（SCHEMA_SQL 外的 ensureSchema 序列 / `schema.ts` / drizzle 迁移）；`uploadDocument` 的外壳重试循环**绝不能在 `withDocLock` 回调内再次锁同一 doc id**（链式锁自死锁）；insert 撞 `SQLITE_CONSTRAINT_UNIQUE` 的重试分支不删已写盘文件。
2. **覆盖上传翻转守卫**：update 的 WHERE 必须带 `eq(name, ...)`，`changes()==0` 时跳过 `indexDoc`/`ensureShareUrl`/远端清理并回壳层重试——这是防孤儿 FTS 行与 share_links FK 500 的唯一防线。
3. **跨类型同名互斥**：upload/ensureFolder/createFolder/rename/move 任一入口放宽"同 parent 同名即拒"都会复活 EISDIR/EEXIST 500 与陷阱目录。
4. **`submitAction` 信封契约**：SvelteKit `fail()` 经 JS fetch 以 HTTP 200 + `{type:'failure',status}` 返回——**任何 fetch 调 form action 的新代码必须走 `lib/shared/form-action.ts`**，裸读 `r.status`/`r.ok` 会把失败当成功（本次实测踩中）。
5. **滚动锁引用计数**：浮层滚动锁必须走 `lib/shared/body-scroll.ts`；ActionSheet 的 `dialog.close()` close 事件是异步派发的，任何"关 A 开 B"的串联都依赖计数而非单一布尔。
6. **浮层 history 编排**：`overlay-history.ts` 的 push/consume/markConsumedByPop 三段式；嵌套浮层（sheet→drawer）必须先 `await consume()` 再开下一个，否则会弹错条目。
7. **归档暂缓表**：`tiering.ts` 的 `archiveSkipUntil`（坏候选 24h 暂缓）依赖 runArchiveCycle 入口的过期清理保持 Map 有界；新增 skip 理由须同样登记。
8. **迁移与运行时建表双路径**：生产新部署只走 `ensureSchema()`（SCHEMA_SQL + 去重 + 唯一索引），drizzle 迁移只服务 dev——schema 演进必须两侧同步 + 通过 `db-init.test.ts` 的 A-2 等价性守卫。

## 4. 复审建议流程（新会话若被要求复审）

1. 基线：`bun run test`（418 全绿）+ `bun --filter remote-reader-web check`（0 错，3 个已知警告）+ `bun --filter remote-reader-mcp-bridge check` + `bun run build`。
2. 对照审查报告 P1/P2 逐项核对修复存在性（多数有带编号的回归测试，`-t 'P1-1'`/`'P2-3'` 等可过滤）。
3. 重点盯 §3 八条不变量对应的测试是否仍覆盖（并发首传/翻转守卫/跨类型/信封/饥饿/等价性守卫）。
4. UI 行为用 Playwright（桌面 1280×800 + 移动 375×667），注意 §2 的水合稳定窗。
