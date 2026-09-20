# AGENTS.md

本文件为在本仓库工作的 AI 编码代理（Claude Code / Codex / OpenCode / Cursor 等）提供项目上下文与工作规范。

## 项目概述

Remote Reader 让远程工作的 Agent 通过 MCP 上传 Markdown 文档，用户在浏览器查看。核心场景：Agent 上传文档 → 拿到免登录查看链接 → 通过 IM 发给用户 → 用户点击一步看到渲染结果。

## 当前状态

**子计划 1/2/3 全部已实现并 merge `master`**：Web 上传 API（`POST /api/v1/documents`，token 认证 + content_hash 幂等）+ 免登录查看页 `/s/<token>`（markdown-it + Shiki SSR + Mermaid + KaTeX）+ 注册/登录/session/logout；本地 MCP 桥（`apps/mcp-bridge`，stdio，`upload_document` 工具）；文件管理器（双栏列表/预览/删除）+ `/d/<id>` owner 查看页 + API token 管理 UI（`/settings/tokens`，创建/撤销 + 一次性 reveal）+ 分享 token 管理 UI（`/settings/shares`，撤销）；速率限制（上传/登录，见 `apps/web/src/lib/server/ratelimit.ts`）；Docker（多阶段 Dockerfile + docker-compose，非 root 运行）。后续已交付：`/s/<token>` 查看页视觉改造（精修 GitHub 调性 + 深色模式 + mermaid lightbox）+ 文件管理页修复（文件树点击导航改 SvelteKit `goto` + 重命名 inline edit）+ 表格手机端渲染修复（`td/th overflow-wrap:break-word` 修竖条根因 + 客户端测量分档 `.rr-shrink`/`.rr-wide` + 宽表全屏 overlay 选字复制友好；多 Agent 交叉审核 v2 落地）、文件管理器目录树产品级改造（折叠/展开 + localStorage 按用户记忆 + 当前路径自动展开定位 + 直接子项计数 + SVG 图标/a11y；树逻辑提取纯函数 `apps/web/src/lib/shared/folder-tree.ts` 单测覆盖；effect 仅依赖 currentId + untrack 防折叠回弹）。364 单测 + svelte-check 0 错 + 桥 tsc 0 错 + Docker 构建冒烟全过。

- 子计划 1：✅ 完成（`docs/superpowers/plans/2026-07-18-web-core.md`）
- 子计划 2：✅ 完成（`docs/superpowers/specs/2026-07-19-mcp-bridge-design.md` + `docs/superpowers/plans/2026-07-19-mcp-bridge.md`）
- 子计划 3：✅ 完成（`docs/superpowers/specs/2026-07-19-sub3-management-ui-docker-design.md` + `docs/superpowers/plans/2026-07-19-sub3-management-ui-docker.md`：管理 UI + md 增强 + Docker）

**安全审核修复（2026-07-19，多 Agent 审核 + 3-lens 交叉复核）**：数据完整性（C1 运行时建表 / H1-H2 写盘原子 / H3 `foreign_keys=ON` / M9 重名校验）、认证加固（H4 invite fail-fast + 注册限流 / M3 SESSION_SECRET 强度 / M7 firstUser 事务 / 登录时序恒定）、客户端安全（H6 CSP report-only / H7 referrer no-referrer / M1 cache-control no-store）、性能（M12 索引 / M13 markdown 单例+缓存 / ratelimit Map 回收）、部署（M14 BASE_URL 不硬编码 / M15 /api/health healthcheck）、代码质量（删死代码 / 单源 env / 去 any）。测试 102→159。

**全项目审查 + 修复（2026-07-24，6-Agent 并行审查 + 逐条实测复核）**：真问题 2 个——auth-routes 测试 helper 未适配 `fail()` 语义（`cd8384e` 重设计回归致 7 用例断言失效）、`BASE_URL` 生产默认 localhost 无 fail-fast（M14 半修，已加 startup-check 非 localhost 校验）；加固——db `busy_timeout` 显式化（核验 better-sqlite3 默认已 5000ms，原"无 busy_timeout"系误判）、上传 API 认证失败按 IP 限流（`AUTH_FAIL_RATE_LIMIT_MAX` 默认 30）、`docker-entrypoint.sh` 改 `#!/bin/bash`+`set -euo pipefail`；补 session/`/d/[id]`/settings/logout/文件管理器 5 处测试盲点。第二阶段复核纠正 agent 幻觉 3 处（CSP"不完整"/M7"偏差"/crypto·auth·apitoken"无测试"）+ TDD 证伪"高优先"误判 3 处（busy_timeout/markdown 丢内容/deleteNode throw）。测试 159→200。（后续多次迭代累计至 259；冷热分层落地 294、审查残留加固后 298、最近文档视图 342、最近浏览视图 364。）

**冷热分层归档（2026-09-04 设计定稿并实现）**：冷文档（默认 30 天未访问未更新）自动归档 S3 兼容对象存储（七牛/R2/OSS 网关/MinIO 通接），本地只留热文档；冷文档同步拉取可看+后台回热、标题可搜；未配置 OBJECT_STORE_* 行为不变。spec：`docs/superpowers/specs/2026-09-04-cold-hot-tiering-design.md`。

**最近文档视图（2026-09-08）**：文件管理器右栏分段切换「目录内容 ⇄ 最近文档」（URL `?view=recent`，左树常驻）；全局 `updated_at DESC` 平铺（keyset row-value 分页 + `documents_owner_type_updated_idx` 索引三处同步 + `GET /api/recent` session 端点 + 无限滚动哨兵）；行内操作后 re-sync 保持列表深度不缩回（delete/move 额外 invalidateAll 刷左树）；面包屑 `folderNamesOf` + 相对时间 `formatRelative` 纯函数。spec：`docs/superpowers/specs/2026-09-08-recent-documents-view-design.md`。

**最近浏览视图（2026-09-12）**：文件管理器第三分段「最近浏览」（URL `?view=viewed`）按 owner 本人浏览时间倒序；新列 `owner_viewed_at`（与 `last_viewed_at` 分层信号语义分工）；查看页 `$effect`+`lastReported` 守卫发 beacon `POST /api/view/[id]`（session+owner 校验，hover 预取机制性排除，同路由参数切换也入序）；`recentFiles`/`/api/recent`/`RecentList` 参数化 `sort=updated|viewed`（keyset 游标按 sort 解释）。索引 `documents_owner_type_viewed_idx` 收敛在 `ensureOwnerViewedColumn` 列兜底后创建（存量库升级安全）。spec：`docs/superpowers/specs/2026-09-12-recently-viewed-design.md`。

**全站主题系统精修（2026-09-13）**：浅色/深色两档精修 + 三档切换（auto/light/dark，auto 跟随系统实时响应，localStorage `rr-theme` 纯客户端按浏览器隔离）；Shiki 双主题化（`github-light`+`github-dark` dual themes、`defaultColor:false` 输出 `--shiki-light/--shiki-dark` CSS 变量——浅色下代码块浅底，切换纯 CSS 零重渲染、RENDER_CACHE 兼容）；主题变量全站单源 `apps/web/src/styles/theme.css`（:root 浅色 + `[data-theme=dark]` 深色 + body 承接 + Shiki 取色规则；**页面组件禁止再写死主题色值，新语义色先加变量**）；全站 11 个路由/组件硬编码色迁移（含视觉验收补迁移的 FolderTree/RecentList，新增 `--rr-success-soft`）；补引入 katex.min.css（与 JS 同步懒加载，存量缺陷修复）。视觉验收：Playwright 双档 17 屏 + FOUC/切换循环实测 + 双 oracle 审查终轮通过。spec：`docs/superpowers/specs/2026-09-13-reader-theme-system-design.md`（§9 实现现状含遗留备案）。

**邀请码管理（2026-09-14）**：注册邀请码由静态 env 单码升级为 DB 管理——新表 `invite_codes`（仅存 sha256 哈希，`ri_` 前缀明文一次性 reveal，同 api_tokens 模式）；admin 专属管理页 `/settings/invites`（生成时选有效期 1/7/30 天 + 软撤销 `revoked_at` + 列表含核销计数/最近使用，顶栏设置菜单 admin 可见入口）；注册校验 = `INITIAL_INVITE_CODE` 引导码（存量部署 bootstrap，长期有效）**或** DB 码（同步事务内核销 `used_count+1`，未过期未撤销，better-sqlite3 原子性同 M7 先例）；`packages/shared` 恢复 `User` 接口（app.d.ts 类型化）。服务层 `apps/web/src/lib/server/invites.ts`。测试 364→382。⚠️ 已知存量行为（未回归）：vite dev 不加载仓库根 `.env`，本地 dev 想用引导码需显式 `INITIAL_INVITE_CODE=xxx bun run dev`（apps/web 目录）或独立 DB 冒烟；生产（docker compose env_file / systemd EnvironmentFile）不受影响。

**移动端文件管理器（2026-09-14）**：≤768px 布局重构「内容全屏 + 侧滑抽屉目录树 + 面包屑 + ⋯ action sheet」，桌面端（>768px）零改动——树从顶部 `max-height:32vh` 霸占改为 `<dialog>` 左侧抽屉（`min(80vw,20rem)` 自身滚动，消除双重滚动嵌套；SvelteKit `pushState` 同 URL 浅路由条目兜系统返回键，非返回键关闭 `await popstate` 消费完条目再导航防 SvelteKit 路由条目被弹掉，关闭后焦点归还汉堡）；面包屑替换「根目录/子目录」占位标题（新纯函数 `ancestorChainOf` 返回含 id 链供点击导航，TDD 5 用例）；行操作收进 `ActionSheet.svelte` 底部菜单（`<dialog>` top-layer 原生 Esc/焦点管理，48px 触屏命中区，文件 4 项/文件夹 3 项——重命名/标签关 sheet 后行内表单复用、删除 fetch 直调 `?/delete` 同 RecentList `submitAction` 先例）；移动文档经 matchMedia 判断断点自动开抽屉选择模式；＋📁 紧凑按钮展开新建表单；全局显隐类 `.mobile-only`/`.desktop-only` 置 theme.css（**必须 `!important`**——scoped 布局类特异性 0,2,0 会反杀普通全局规则 0,1,0 致桌面元素在移动端泄漏）；树双份渲染（aside 桌面常驻 + dialog 抽屉内一份，CSS 断点显隐，同 storageKey 折叠记忆共享）。验收：Playwright 375×667 冒烟 7 项（布局/抽屉导航/返回键/面包屑/四操作全流程/新建/三视图）+ 1280×800 桌面回归 + 深色双档视觉（抽屉/sheet 均取语义变量）；验收期修复 4 处（显隐特异性泄漏/目录行 🏷 漏包 desktop-only/sheet content-box 宽度溢出/原生 pushState 触发 SvelteKit dev warning）。测试 382→387。spec：`docs/superpowers/specs/2026-09-14-mobile-fm-design.md`、计划：`docs/superpowers/plans/2026-09-14-mobile-fm.md`。

**全项目审查修复（2026-09-14，审查报告 `docs/reviews/2026-09-14-project-review.md` 全项落地）**：正确性 P1×4——并发首传唯一索引 `documents_owner_parent_name_type_uniq`（COALESCE 表达式索引，插入撞索引回壳层重试；迁移 0007 含存量去重，ensureSchema 启动兜底同款）、file/folder 跨类型同名提前 409（`NameConflictError`，upload/ensureFolder 预检 + createFolder/rename/move 去掉 type 过滤）、adapter 413 不再被吞成 400 + `BODY_SIZE_LIMIT≥MAX_UPLOAD_BYTES×1.5` 启动校验（解析器与 adapter-node 同语义）、getBaseUrl 尾斜杠归一化（防 `//s/<token>` 404）。P2×12——api-client 60s 超时 + 错误体读真实 `{message}` 形状、覆盖上传 `changes()` 翻转守卫（防孤儿 FTS/FK 500/路径错位，锁内不递归防自死锁）、rename 同步 `docs_fts.name`、注册核销与建用户同事务（409 不烧计数 + UNIQUE 兜 409）、登录叠加 `login-agg:${ip}` 聚合限流（`LOGIN_IP_RATE_LIMIT_MAX` 默认 30）、DTO 收敛（`toDocDTO`：/api/recent、FM load、search 显式映射，storagePath/contentHash 不进载荷）、归档候选 ORDER BY + 坏候选 24h 暂缓（防饥饿）、上传 path ≤32 段/≤1024B。前端——滚动锁引用计数 `lib/shared/body-scroll.ts`（ActionSheet 异步 close 事件不再误清抽屉锁）、浮层 history 编排 `lib/shared/overlay-history.ts`（ActionSheet 也兜返回键）、Mermaid Enter 判 target + gestures destroy、双树断点互斥挂载（matchMedia `isMobile`，折叠记忆经 localStorage 承接）、旧 WebKit fullscreen promise 守卫、lightbox Tab 焦点圈定 `lib/shared/focus-trap.ts`、表单失败可见反馈+防重（FM actions 统一 `fail()` 带消息；**fetch 调 action 须用 `lib/shared/form-action.ts` 的 `submitAction`——fail() 以 HTTP 200 + `{type:'failure',status}` 信封返回，裸读 r.status/r.ok 会把失败当成功**）。架构——A-1 行级三组件 `InlineNameForm/InlineTagForm/RowActions` + 行级基类收敛 theme.css、A-2 schema↔ensureSchema 等价性守卫测试、A-3 `tests/helpers.ts resetDb()`（21 文件）、A-5 `AuthCard`、A-7/A-8/A-9 小项。**服务层错误风格裁定**：路由层 `error()/fail()`；服务层"预期业务失败"用 result 对象（rename/move）或类型化异常（NameConflictError/SetTagsError），"系统错误"抛裸异常——新代码照此选边。测试 387→418，Playwright 13/13 冒烟（桌面+移动全流程）。

**循环审查修复第 2 轮（2026-09-15，4 路并行审查 20 条发现全确认 + Oracle 复审修正 3 项）**：正确性 P1×3——① move 后向旧路径上传静默覆盖被移走文档（moveNode 只改 parentId 不动磁盘 + 新建分支 writeFile 无共享检测 → 两行共享一物理文件、内容污染、hash 永久错位、删除联动丢数据）：**moveNode 现同步迁移子树全部 file 行**（BFS 收集 + hot 行 renameSync + 事务内重读对齐 hash/size/FTS + cold 行只改指针；IO 全在事务外、事务/物理任一失败双向回滚——绝不留「文件已迁/DB 未迁」子树 404 错位），上传新建分支加 **squatter 自愈**（目标路径被陈旧 storagePath 占用时先迁走占位行；父链断裂孤儿行直接清理防 409 死锁）+ 落库前复查父目录仍在（防 delete-race dangling parentId 孤儿）；② FM 子目录新建文件夹 `action="?/createFolder"` 因 WHATWG 相对解析替换整个 query 而丢 dir → 建到根目录：表单 action 改编入 `?dir=<id>&/createFolder`（已真实 HTTP 端到端实证）；③ 路径无单段 255B 限制 → ENAMETOOLONG 500 + 孤儿 folder 行：parsePath 单源拦截（TextEncoder 字节计）。P2——搜索 name LIKE/最终查询补 `type='file'`（防 folder /d/ 死链+挤占名额）、覆盖上传翻转守卫补 parentId 条件（防 move 竞态穿透）、/d/[id] 与 settings/tags 的 action `error()`→`fail()`+前端 failure 分支+no-JS form prop 渲染、api-client default 透传 409 message、upload API body null→400、桥 config 空白 env 先 trim 再回退。前端 P3——/d/[id] 标签草稿 $state 化（防同路由切换清输入）、顶栏 details 菜单导航后收起、tokens/invites 生成表单防双发。架构——createFolder 下沉服务层（`findSiblingByName` 收敛 4 处同名冲突查询）、/s/ 取行走 `getDocumentById`、死 CSS/重复 CSS 块清理、`--rr-scrim-strong` 变量化、4 组件 43 处 `var()` 回退色值删除（theme.css 双档单源）、`redeemInviteCode` 死导出删除。INSTALL.md 标注 DATA_DIR 须大小写敏感 FS（macOS dev 注意）。测试 418→433，svelte-check 警告 7→5（余为有意快照/autofocus）。

**循环审查修复第 3 轮（2026-09-15，cycle2 换角度 4 路审查 + 全量逐条复核）**：P1×2——① **反代部署下 `getClientAddress()` 恒返回反代地址**（adapter-node 5.5.7 默认不读 X-Forwarded-For，需 `ADDRESS_HEADER` env）→ login-agg/register/authfail 全部 per-IP 限流退化为全站共享单桶，30 req/min 即可持续禁用全站登录/注册：INSTALL.md §6 + .env.example 补 `ADDRESS_HEADER=x-forwarded-for`（XFF_DEPTH 默认 1 取链尾=真实 IP 不可伪造）+ 3000 端口仅反代可达提醒；② **移动端「最近文档/浏览」无限滚动哑火**（IO root=.fm-right 在 ≤768px 是 height:auto 不裁剪块 → 哨兵恒 intersecting 仅首帧回调一次；2026-09-14 移动端改造把滚动轴移到页面后未同步 IO root）：root 改视口（null），桌面预载语义不变。P2×6——squatter 自愈改在**占位行 doc 锁内**进行且提到 attempt 循环顶（覆盖/新建分支统一入口；与该行在途归档 unlink/回热 writeFile 在线程池交错会致 hash 永久错位或误删刚上传文件；锁单独持有防双向占位嵌套死锁）、覆盖分支补同款占位检查（pre-fix 双陈旧行互踩）、storage.ts tmp 名改同目录固定短名（`${path}.tmp.` +17B 会击穿 NAME_MAX 使 239B+ 合法长名 500）+ 写入失败也清 tmp、backfillFts 灌入前重验行热态（读盘让出窗口内刚被归档的文档防全文重灌泄漏）、object-store-s3 get 的 body 流读取包错误映射（503 语义不再降级 500）、/d/[id] 标签编辑态随文档切换重置（同路由切换残留 A 草稿误写到 B——F4 修复的孪生边界）。P3——settings tokens/shares/invites 的 action `error()`→`fail()`+前端 failure 横幅、login/register 防双发后焦点归还、Mermaid/表格 overlay 补 body 滚动锁（overlayOnMount）、math 解析器边界（`$...$` 首尾空白防护防货币误判、math_block 注册 alt:paragraph 段落直连可渲染+silent 闭合预扫、`$$` 同行尾随内容并入公式体）。测试 433→439。**新增不变量：squatter 处理必须在占位行 doc 锁内单独进行（调用方不得持其他 doc 锁）；storage tmp 命名不得叠加在原名上**。新备案（P3 级，未修）：drizzle 迁移 0000 无 IF NOT EXISTS（先跑服务再 db:migrate 会重放报错，纯 dev 坑）；0007 迁移非原子（毫秒级崩溃窗口卡 migrate，需手工干预）；CSP report-only 缺 frame-ancestors（转 enforcing 时一并加）；反代示例的 X-Forwarded-Proto 头当前无消费者（需 PROTOCOL_HEADER 才读）；孤儿占位行清理的 unlink 与并发上传 rename 线程池顺序竞争（需父链断裂孤儿+双路并发上传同路径，极窄）；InlineNameForm/InlineTagForm/tokens/invites 按钮 disabled 焦点丢失（login/register 已修，行内表单成功即关失败保持，影响极小）。

**循环审查修复第 4 轮（2026-09-15，cycle3 聚焦复审 + 集成一致性，循环收敛）**：cycle3 对抗复审发现 2 个 P2（均实测确认）——① markdown math_block 对连续单行 `$$ x $$` 公式：下一行行首 `$$` 被误当闭合定界（吞掉相邻公式 + 公式体混入尾随 `$$` 致 KaTeX 报错）→ 补**同行自闭合探测**（跨行扫描前判定，行尾 `$$` 即闭合）；`$$..$$` 带同行尾随文本时 inline 规则不再剥壳（前字符为 `$` 拒绝，字面回落）。② /d/[id] 第 3 轮的 `{#key data.id}` 修复无效（Svelte 5 中 key 只重建 DOM 不重置 script 层 `$state`，A 草稿仍会误写到 B）→ 改 `$effect(data.id)` 显式重置编辑态。集成一致性 3 条 P2——README 双语 "~15 语言" 陈旧（实际 39 种）、.env.example 缺 LOGIN_IP_RATE_LIMIT_MAX/REGISTER_RATE_LIMIT_MAX + INSTALL §9 汇总表缺 5 键（ADDRESS_HEADER/XFF_DEPTH/AUTH_FAIL/LOGIN_IP/REGISTER）、e2e-check.sh 补单段 300B→400 与跨类型同名 409+message 透传两段冒烟——均已修。对抗复审同时确认：squatter 锁序/conflict 不可达性（唯一索引论证）、IO root:null 桌面不退化、overlayOnMount 配对、beacon 与编辑态重置无交互、幂等分支 squatter 查询成本可忽略（owner 前缀索引收敛）；resetDb 全表覆盖、测试断言强度、shared exports、build 冒烟均干净。测试 439→442。**循环收敛判定**：4 轮发现数 20→19→5→0（第 4 轮为修复后复审无新发现），全部修复经测试锁定，无未决 P1/P2。

**分享状态可视化与行操作收敛（2026-09-16）**：FM 行首 emoji 换 SVG 双样式图标（`FileStateIcon`：文件夹/私有文件/共享文件+链接角标；`shared` 布尔由 `share_links` 活跃链接派生进 `RecentDoc`/`DocDTO`，load 与 `/api/recent` 批量填充，folder 恒 false）。行操作收敛单一 ⋯：桌面新 `ActionMenu`（fixed 锚定下拉，外点/Esc/滚动关闭）+ 移动 ActionSheet，菜单项两端同构（共享文件 6 项：重命名/标签/移动/复制分享链接/转私有[仅 shared 时]/删除；私有 5 项；文件夹 3 项），桌面行内 ✏📂🗑 与两视图行内 🏷 按钮全部移除进菜单；新端点 `POST/DELETE /api/share/[id]`（session 认证，get-or-create 与全撤语义，404 不泄漏存在性）；`ShareDialog` 居中浮层展示 `/s/` URL + clipboard/execCommand 双路复制；ActionSheet 与目录树抽屉补 backdrop 点击关闭；三视图页签恒右贴边（右簇重排 [新建入口][segmented 恒末位]）。`ensureShareUrl` 顺修过期盲区（活跃判定单源 `activeShareOf`）。RecentList 增 `isMobile` prop 路由双端菜单。测试 442→458，Playwright 浏览器验收 16/16（桌面 1280×800 + 移动 375×667）。上线后审查跟进（5 线审查 MAJOR/IMPORTANT 闭环）：`rowActions`/分享 fetch 收敛 `lib/shared/row-menu`/`share-api` 单源（+5 单测，两端菜单防漂移）、RecentList 错误通道统一 `actionError`、USER_GUIDE/README 中英同步分享操作说明、`aria-haspopup` 移除（role=group 诚实化）。测试 442→463。spec：`docs/superpowers/specs/2026-09-16-fm-share-state-design.md`（§10 实现现状 + 审查跟进备案）。

**Agent 自助接入（2026-09-20）**：登录页 `<details id="agent-guide">` 指引块（默认收起保持页面干净、内容始终在 SSR HTML 中供 Agent 抓取——baseUrl/repoUrl 由 load 注入，repoUrl 来自新 env `BRIDGE_REPO_URL` 默认上游仓库；指引含装桥 bunx/clone 二选一、注册/登录/建 token curl、桥配置、MCP 注册、错误形状说明）+ 认证 JSON API 三端点（`POST /api/v1/auth/register` / `auth/login` / `auth/api-token`）。注册/登录核心逻辑下沉 `lib/server/registration.ts`（`registerUser` result 对象 + `authenticateUser` 时序恒定，form action 同步改用、行为不变）；限流与 form 同键同桶（register 单桶 / login 双桶）；api-token 走 session（locals.user），token 明文一次性返回；错误形状 SvelteKit `error()` 扁平 `{message}`。新增 registration/auth-api/auth-api-ratelimit 测试 + e2e-check `agent-guide` 冒烟与 `E2E_INVITE_CODE` 全链路（真实 server register→token→upload 已验证）。已知坑：vitest 下 Vite 注入 `process.env.BASE_URL='/'`（归一化成 ''），涉 BaseURL 断言的测试须显式设值密闭化。spec：`docs/superpowers/specs/2026-09-20-agent-auto-onboarding-design.md`。**上线后审查跟进（5-Agent 并行审查 + 逐条复核，全项闭环）**：scripts/README e2e 节同步新检查项/`E2E_INVITE_CODE`/成功文案、USER_GUIDE §4 表补 `BRIDGE_REPO_URL`（中英）、api-token CSRF 注释三层防线精确化（SameSite=lax 主防线 + checkOrigin 拦 text/plain 跨站 + 无 ACAO）、form/JSON 跨入口同桶回归锁定（register 单桶 + login 精确/聚合双桶共 3 用例，防限流键漂移静默分桶）、卫生上限（email ≤254 / password ≤1024 / token name ≤100——`MAX_TOKEN_NAME` 服务层导出双入口共用，authenticateUser 超长密码跳过 argon2）、bootstrap 码改 sha256+`timingSafeEqual` 恒定时间比较（防前缀时序侧信道）。

**桥运行时**：无原生依赖（纯 fetch + MCP SDK）→ `bun apps/mcp-bridge/src/index.ts` 直跑；`tsc --noEmit` 类型检查（`bun --filter remote-reader-bridge check`）。配置 = `~/.config/remote-reader/config.json`（XDG）默认 + `REMOTE_READER_URL`/`REMOTE_READER_TOKEN` env 覆盖。**注册进 MCP 客户端时入口必须用绝对路径**——客户端拉起 stdio 进程的 cwd 无保证（如 ZCode 设置页探针），相对路径会间歇性 Module not found（README/INSTALL/USER_GUIDE 的注册命令均已改为 `$(pwd)` 展开写法）。

产品/使用/设计文档：`docs/PRODUCT.md`、`docs/USER_GUIDE.md`、`docs/superpowers/specs/`（含 §15 实现现状）。**改动架构前必读 spec。**

## 架构（Big Picture）

三大组件（详见 spec §3）：

- **Web 应用**（`apps/web`，SvelteKit 全栈）：存储 + md 渲染 + HTTP API + 认证，部署在远程服务器（单实例）
- **本地 MCP 桥**（`apps/mcp-bridge`）：部署在用户机器，把 Agent 的 MCP 工具调用（stdio）转发为对 Web API 的 HTTP 请求；持有 API token，不暴露给 Agent
- **共享层**（`packages/shared`）：MCP 工具定义、API client、类型 —— 被 web 和 bridge 共用

主流程：Agent 调 `upload_document` → 桥转发 → Web API 落盘 + 自动生成 share token → 返回 `/s/<token>` URL → 用户点链接免登录一步查看。

关键设计原则（spec §3.2 / §6.4 / §8）：

- **MCP 工具逻辑与 transport 解耦**：工具函数写在 `packages/shared`，本地桥用 stdio 挂载，未来远程 MCP server 用 Streamable HTTP 挂载同一套函数
- **为一次性文档优化**：查看页 `/s/<token>` 是主入口（免登录一步到渲染），文件管理器是次要整理工具
- **默认私有 + 可分享**：文档不公开遍历，凭 share token 或 owner 登录访问；上传自动生成一个查看 token，owner 可撤销
- **幂等上传**：按 path 定位 + content_hash 判断 created/覆盖/跳过；上传工具只返回 `{id, url}`（无 action 字段）

## 技术栈

TypeScript · Bun（包管理 + dev/build 宿主；测试与生产跑在 node） · SvelteKit（全栈，SSR+CSR 混合） · Drizzle ORM + SQLite（`better-sqlite3` 驱动） · markdown-it（服务端渲染，`html:false` 防 XSS） · Shiki（代码高亮，预载 ~38 种语言 + 未覆盖语言 text 保底降级） · Mermaid.js + KaTeX（客户端增强） · `@node-rs/argon2` argon2id（密码哈希） · vitest（node 下跑测试） · `@modelcontextprotocol/sdk`

> ⚠️ **为何不用 `bun:sqlite` / `Bun.password`**：SvelteKit 的 SSR 在 Vite 下运行，Vite 不解析 Bun 专属模块（`bun:*`/`Bun.*`）。故服务端一律用 node 兼容的 `better-sqlite3` / `@node-rs/argon2` / `node:crypto`。代价：`better-sqlite3` 在 bun 直接运行时加载失败，所以测试用 vitest（node）、生产用 `node apps/web/build/index.js`。详见下方「开发命令」的运行时分工注。

## Monorepo 结构

Bun workspaces，`apps/web` 与 `apps/mcp-bridge` 都依赖 `@remote-reader/shared`（`workspace:*`）。SvelteKit alias：`$server`→`src/lib/server`、`$components`→`src/lib/components`、`$shared`→`packages/shared/src`。

## 开发命令

根 `package.json` 提供 `bun run dev` / `bun run build` / `bun run test` 快捷方式（转发到 web workspace / vitest）。`bun run test` 经 vitest 的 node shebang 在 node 下跑（不用 bun 直接跑）。

```bash
bun install                                    # 装所有 workspace 依赖
bun run dev                                    # = bun --filter remote-reader-web dev（SvelteKit dev，http://localhost:5173）
bun run build                                  # = bun --filter remote-reader-web build（adapter-node 产物 → apps/web/build/）
bun --filter remote-reader-web check           # svelte-check 类型检查（src + .svelte）
bun --filter remote-reader-web db:generate     # 生成 Drizzle migration
bun --filter remote-reader-web db:migrate      # mkdir data + 执行 migration（含已生成 schema）
bun --filter remote-reader-bridge check    # 桥 tsc --noEmit 类型检查
bun run test                                   # 跑所有测试（vitest，node 运行时，fileParallelism:false）
bun run test apps/web/tests/auth.test.ts       # 跑单个测试文件
bun run test -t "测试名片段"                    # 按测试名过滤
```

> **运行时分工（已验证）**：`better-sqlite3` 是原生 addon，**bun 直接运行时（`bun -e`/`bun run *.ts`）加载失败**（oven-sh/bun#4290），但 `bun + vite dev` 下可加载。因此：测试用 **vitest**（`bun run test`，经 vitest 的 node shebang 在 node 下跑）；dev/build 用 bun；**生产用 `node apps/web/build/index.js`**（adapter-node 产物，勿用 `bun run` 启服务；入口是 index.js 不是 handler.js）。

⚠️ **部署注意**：用 `adapter-node` 产物 + **`node apps/web/build/index.js`** 启动（不要 `bun run` 启服务，会触发 better-sqlite3 加载失败），**不要用 `bun build --compile`** 打单二进制（oven-sh/bun#15734 已知不兼容，详见 spec §10）。生产必填 `SESSION_SECRET`（缺失 fail-fast）；`BODY_SIZE_LIMIT` 必须是字节数（数字，须 > `MAX_UPLOAD_BYTES`）。

## Git 工作流（用户明确规则）

- **commit**：完成一组改动并通过验证后**主动提交**（原子化拆分、跟随项目 semantic 中文风格），无需等用户开口。
- **push**：**必须等用户明确允许**后才推远端，永远不擅自 push。

## 运维 / 部署辅助脚本

```bash
node scripts/seed-token.mjs <email>            # 免 UI 直接为某用户生成一个 API token（直写 SQLite，明文打印一次）
API_TOKEN=rr_xxx BASE_URL=http://localhost:5173 bash scripts/e2e-check.sh   # 端到端冒烟：上传 → /s/<token> 200 → 错误场景
docker compose up --build                      # 一键起服务（:3000），data/ 挂载为卷
```

**Docker 非 root 运行**：`docker-entrypoint.sh` 先 `chown -R node:node /app/data`（host 首次建卷常是 root 属主），再用 `runuser -u node` 降权跑 `node apps/web/build/index.js`；healthcheck 命中 `/api/health`（含 DB `SELECT 1`，DB/磁盘故障返回 503）。改 entrypoint / Dockerfile 前看 sub3 设计 spec。

## 环境变量（完整清单见 `.env.example`）

env 助手为 `lib/server/env.ts`（共享 getter + DATA_DIR 等调用点就地读取，测试需逐文件覆写）；生产启动校验（SESSION_SECRET/INITIAL_INVITE_CODE/BASE_URL/BODY_SIZE_LIMIT×1.5）见 `lib/server/startup-check.ts`。

核心：`DATABASE_PATH`、`DATA_DIR`、`BASE_URL`（生产必填，缺失 fail-fast；尾斜杠自动归一化）、`SESSION_SECRET`（生产必填，缺失 fail-fast）、`INITIAL_INVITE_CODE`（注册首个管理员所需）、`MAX_UPLOAD_BYTES`、`BRIDGE_REPO_URL`（登录页 Agent 指引块展示的桥源码克隆地址，可选）。运行时数据在 `data/`（已 gitignore，**绝不入库**）。

速率限制 / 会话 / 网关：`RATE_LIMIT_MAX` + `RATE_LIMIT_WINDOW_MS`（每 token 上传）、`LOGIN_RATE_LIMIT_MAX`（每 (IP,邮箱) 精确桶）+ `LOGIN_IP_RATE_LIMIT_MAX`（每 IP 聚合桶，默认 30，防密码喷洒）、`REGISTER_RATE_LIMIT_MAX`、`SESSION_MAX_AGE`（session 有效期秒，默认 30 天）、`BODY_SIZE_LIMIT`（adapter-node 请求体字节数，生产须 ≥ `MAX_UPLOAD_BYTES`×1.5，启动校验强制）、`ORIGIN`（生产必填且与 BASE_URL 同源，启动校验强制——adapter-node CSRF Origin 校验基准，漏设则全部表单 POST 被 403 Cross-site forbidden，install.sh 自动写 `ORIGIN=${BASE_URL}`）、`PORT`（生产端口，默认 3000）。

冷热分层：`OBJECT_STORE_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY`（S3 兼容，全部留空=关闭）、`OBJECT_STORE_FORCE_PATH_STYLE`、`COLD_TIER_AFTER_DAYS`（默认 30）。

## 安全要点（项目特有）

- **路径穿越**：Agent 传的 path 必须经 `parsePath`（`packages/shared/src/paths.ts`）sanitize，禁 `..`/绝对路径/null byte
- **md XSS**：markdown-it 必须保持 `html:false`；渲染产物用 `{@html}` 输出（受信 HTML）
- **凭证**：API token 只存 sha256 哈希，明文仅生成时显示一次；密码用 argon2id
- **权限**：API 操作校验 `owner_id == token.user_id`；`/s/<token>` 凭 token 访问（设计如此，绕过 owner 检查）

## 文档指针

- 设计 spec（权威）：`docs/superpowers/specs/2026-07-18-remote-reader-design.md`
- 实现计划：`docs/superpowers/plans/`（按子计划编号）
