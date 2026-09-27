
---

## 6. 修复记录（2026-09-27，R-01..R-44 全数闭环）

> 执行方式：4+1 批次（批1 P1 / 批2 P2 / 批3 P3 / 批4 裁量项 / 文档批中英一次回写），代码修复一律 TDD（先红后绿）；
> 裁量项 R-07/R-19/R-23/R-14 经用户确认全部执行。门禁终态：**785/785 测试、svelte-check 0 错、桥 tsc 0 错、build 成功、e2e-images 17 断言、e2e-check 全绿**。

| # | 修复说明 | 验证 |
|---|---|---|
| R-01 | PRODUCT.md/PRODUCT.en.md §5 重写至 2026-09-26 现状（标签搜索/冷热分层/最近视图×2/主题/移动端/邀请码/分享可视化/Agent 自助/图片/锚点），Phase 3 移除已交付项、路线图加 Phase 2+ 行 | 人工比对 AGENTS.md 交付清单 |
| R-02 | markdown.ts anchor 配置覆写 `getTokensText`（allowlist text/code_inline/**math_inline**）+ callback 按 title 重算空 slug 回滚 id（旁路插件 `-1` 去重） | markdown.test.ts +3（`前-x2-后缀`/`求-x-解`/空 id 跳过） |
| R-03 | `/s/` 顶栏返回链接仅 ownerView 渲染；匿名占位空节点维持 space-between | e2e-check 新断言（匿名页 grep 返回文案 = 0，实机验证） |
| R-04 | USER_GUIDE §3.2 补三视图/搜索/标签/主题/移动端/邀请码；README/README.en ✨ 特性同步 | 中英双份回写 |
| R-05 | INSTALL 中英反代示例 8m→24m + 注释改为「≥ BODY_SIZE_LIMIT（图片 base64 中转 10MB≈13.7MB body）」 | 文档 |
| R-06 | 新建 `lib/shared/row-orchestrator.svelte.ts`（RowActionOrchestrator）：菜单 ctx/rename/tags/share/unshare/delete/错误态/乐观移除单源；FM 页与 RecentList 共用一实例、浮层三件套页持一份；乐观移除漂移对齐（两端统一）；vitest.config.mts 加 svelte 插件（`.svelte.ts` 转译） | row-orchestrator.test.ts 10 用例 + 浏览器冒烟 5 断言（菜单/重命名/删除乐观移除/recent 标签） |
| R-07 | documents.ts 789 行纯移动拆分：`documents-tree.ts`(140 查询)/`documents-upload.ts`(234 上传管线)/`documents-tree-ops.ts`(299 树变更)/`documents.ts`(187 读路径+barrel，历史导入路径零变化) | 784 测试拆分前后原样通过 = 零行为变化 |
| R-08 | tokens/invites create 补 failure 分支 + `form?.error` no-JS 渲染；FM createFolder 补 `form?.error` | svelte-check + 手查模板 |
| R-09 | ImageLightbox（onMount push/卸载 consume）、MermaidViewer 与 TableFullscreen（open push/close consume + popstate 标记）接入 overlay-history——Android 返回键关浮层 | 代码审查 + e2e-images 回归（lightbox 开关循环不破坏 history 平衡） |
| R-10 | FM rename action `invalid`→400（磁盘失败不再误报 404） | file-manager.test.ts（物理目录占位 EISDIR → 400） |
| R-11 | lib-deploy.sh 新增 `rsync_source_tree`/`build_and_prune`，install/update 两份逐字重复块收敛单源 | bash -n + 逐行对照 |
| R-12 | 12 个测试文件 DATA_DIR 从 `./data/test-<ts>` 统一为 `mkdtemp(os.tmpdir())` | 全量测试绿 |
| R-13 | @types/node 三 workspace 对齐 `^22.0.0`（shared 由 ^26 降） | 桥 tsc + svelte-check + build 全过 |
| R-14 | `+page.svelte` 重复 `.doc-tags` 样式块删除 | svelte-check |
| R-15 | e2e-check 三处 curl 管道断言改 `grep >/dev/null`（**根因经验收审查沙箱实证：`curl \| grep -q` + pipefail 的 SIGPIPE 竞态**，300/300 复现、去 -q 后 0/300）+ 一次重试保留作纵深 | 沙箱实证 + 脚本语法 |
| R-16 | README 中英/USER_GUIDE 中英图片口径统一：硬上限 500 张（413）+ 中转 60/min 限流（429 桥自动退避） | 文档 |
| R-17 | PRODUCT 39 语言（批1 顺带）；USER_GUIDE `cd remote-reader` 拼写；SESSION_SECRET 报错引文改中文实际文案（中英 4 处）；错误码表补 409 行（中英）；.env.example AUTH_FAIL 注释重复行删除 | 文档 |
| R-18 | 新增根 `+error.svelte`：状态码 + error.message + 按状态分类提示 + 返回首页/上一页，主题变量随双档 | 实机验证（/s/ 失效 token → 404 页渲染） |
| R-19 | `/s/`+`/d/` load 对冷文档返回未决 promise（SvelteKit 原生流式）+ 模板 `{#await}` 骨架屏/失败文案；热文档仍同步字符串 | tiering-view.test.ts 契约测试（冷=Promise/热=string、503/404 走 promise rejection、+1 热路径锁定） |
| R-20 | 新建 `lib/shared/format.ts` formatBytes，FM 目录视图 + RecentList 行内大小替换 `{n} B` | format.test.ts 2 用例 |
| R-21 | MarkdownViewer 图片 tabindex+Enter/Space 开图（click 补聚焦）；mermaid inline `role=button`+tabIndex+keydown+focus-visible 样式 | svelte-check + 代码路径审查 |
| R-22 | tokens name/invites note/search q 三输入补 aria-label | svelte-check |
| R-23 | theme.css `@media (prefers-reduced-motion: reduce)` 全局动画/过渡归零（4 行，纯 CSS） | CSS |
| R-24 | search.ts `highlight()`→`snippet(docs_fts,2,…,'…',32)` SQL 层截断 | search.test.ts 大文档断言（<全文一半且 ≤400 字符+命中标记） |
| R-25 | `imageTokenLines`：map-less inline 重置 parentMap=null + 同 src 已消费行集合（两措施缺一不可——报告确认仅重置不足） | image-pipeline.test.ts +3（段落→表格/表格→表格/段落×2+表格） |
| R-26 | `createFolder` 校验 parentId（存在+本人+folder），not_found→404 不落孤儿行 | file-manager.test.ts |
| R-27 | invites.ts `MAX_INVITE_NOTE=200` 导出 + 路由校验 | invites.test.ts（action 级 201 字符→400） |
| R-28 | deleteNode 删除后按已删 file 父链向上 rmdir（非空即停/owner 根不越/resolve 归一路径形态）；storage.ts `mkdirDirRaceSafe` 补 recursive-mkdir 并发删除竞态一次重试 | documents.test.ts（a/b、a 清除+owner 根保留）+ P2-2 竞态用例保持绿 |
| R-29 | lib-deploy 公式 ×1.5 改 ceil（`(u*3+1)/2`）；parse_size_bytes 注释口径修正（非法值与 startup-check NaN fail-fast 的语义差异如实说明） | 公式推演 + 注释 |
| R-30 | gen-unit 注释/scripts/README/AGENTS.md 计数 17→22+3 资源上限 | 逐条清点（22 加固指令+MemoryMax/TasksMax/LimitNOFILE+显式 MDS=no） |
| R-31 | api-client 413 分支透传服务端 message（`内容超过大小上限：<msg>`） | api-client.test.ts |
| R-32 | seed-token.mjs 先 `existsSync` 拒空库（不再静默建 0 字节 db） | 脚本逻辑 |
| R-33 | install.sh 健康检查失败 die（原 warn+exit 0） | 脚本逻辑 |
| R-34 | .dockerignore 补 `apps/web/data` + `.env*`→`**/.env*` | 模式匹配 |
| R-35 | uninstall 守卫补 CONFIG_DIR（`/etc`/空拒绝） | 脚本逻辑 |
| R-36 | MermaidViewer fullscreen 状态携 raw；`rerenderOnTheme` 同步重渲打开中的大图 | 代码路径（theme observer 复用既有链） |
| R-37 | `show()` 仅 idx 真变化时重置 loading/imgLoaded（`{#key idx}` 不重建 img → 无 load 事件 → 死锁根因）；双击复位/单图回绕走 resetView 语义 | e2e-images +6 断言（复位 100%/可见/无 spinner ×2 组），17/17 绿（修复前红：`双击复位后图片仍可见` 失败复现死锁） |
| R-38 | README/README.en 快速开始 + INSTALL §3.1 中英：最小必改集扩为四项（+BASE_URL/ORIGIN 同值），注明 localhost 拒启与同源校验 | 文档（对照 startup-check 实际行为） |
| R-39 | RecentList `scrollRoot` 死 prop 与传参删除；哨兵 effect 注释依赖口径修正（仅 sentinel） | svelte-check |
| R-40 | TableFullscreen 暴露 `getOverlayEl()`；MarkdownViewer 图片点击/键盘/裂图兜底双根挂载（container + 表格浮层子树） | svelte-check + 代码审查 |
| R-41+R-43 | `validateInitInput` 归一化不动点：`normalizeImageRef(sanitizeImageName(name)) !== name` 即 400——单点收口 `#`/`?`/`%XX`/`%25`/`%2F`/`%3A` 全族 | images-init.test.ts +2（6 恶性名全拒；孤立 `%`/中文名安全边界保持）+ images-resolve 存量脏行用例改直插行 |
| R-42 | `sanitizeTagName` 增拒逗号（`setDocTags` 服务层纵深同步丢弃） | tags.test.ts +2（renameTag 拒绝/setDocTags 丢弃） |
| R-44 | seed-token.mjs 邮箱 `trim().toLowerCase()`（与注册侧归一化对齐） | 脚本逻辑 |

**备案**：R-15 根因后经验收审查沙箱实证为 SIGPIPE 竞态并已根因修复（三处断言去 `-q`）；R-19 可观察性语义变化（冷文档故障 5xx → 200+流内错误块）为 SvelteKit 流式本征，已在 AGENTS.md 备案。

### 6.1 验收审查记录（两轮 + 终验）

- **第 1 轮（4 路并行 Oracle：服务端 / 前端 / 脚本文档 / 回归横切）**：44 项修复主体全部通过（R-07 纯移动经函数级字节比对证实、R-19 对照 SvelteKit 源码核实）；发现 **P1×1**（`build_and_prune` 在 `if !` 条件上下文中 bash errexit 全函数体被抑制——沙箱实证谎 ✓ 日志 + update.sh 假升级路径）、**P2×4**（overlay-history 堆叠误关两层+死条目；R-29 image 分支 JS double 浮点穿透使 bash ceil 可比 JS 少 1（1746 万组合 18284 对）；INSTALL.md 两处 17 项漏网；R-15 根因实证为 `curl | grep -q`+pipefail SIGPIPE 竞态 300/300 沙箱复现）、P3×5（uninstall CONFIG_DIR 守卫死代码 `/etc//` 穿透、makeFocusable 不随 html 重跑、冷文档可观察性语义、缩进/勘误）。
- **第 2 轮（Oracle 深验 10 项修复，11 场景栈迹矩阵推演）**：8/8 round-2 修复正确完整（含 ActionSheet/ShareDialog/抽屉 legacy 路径与全局派发器并存的幂等性论证、S5 ✕-底假想路径不可达性论证）；顺带发现并修复 `.rr-tbl-stage` pointer capture 劫持 click 致浮层内图片不可点（elementFromPoint 兜底）。唯一新发现 **P3×1**：overlay-history 重写缺已提交回归测试（Playwright 证据为会话内 ad-hoc 脚本）。
- **N-1 闭环**：`apps/web/tests/overlay-history.test.ts` 6 用例入库（`$app/*` 桩 + window/history 假体），测试 785→791。其余 43 行（44 个编号，R-41+R-43 合并收口）全部修复并带测试/验证。
