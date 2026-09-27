# Remote Reader 全项目审查报告（2026-09-26）

- **审查对象**：`cf8362d`（含尚未经任何审查的最近 3 个提交：markdown 标题锚点功能 `ca672ab`/`5dc416f`/`cf8362d`）
- **审查维度**：正确性 · 架构整洁度 · 功能性 · 用户体验
- **约束**：只审查、不修改（`git status` 全程 clean；测试/服务器一律临时目录隔离）
- **方法**：四维度并行审查 → 每条发现逐项独立复核（代码亲证 + 实机验证）→ 仅记录确认项；循环执行至某轮零新确认问题（循环记录见文末）
- **已排除项**：AGENTS.md 中已备案未修的 backlog（drizzle 0000/0007 迁移怪癖、CSP report-only 缺 frame-ancestors、XFF-Proto 无消费者、孤儿占位 unlink 竞态、行内表单 disabled 焦点丢失、Lightbox v1 三项从简偏离、vite dev 不加载根 .env、0.1.0 桥不可达 warnings、CSRF 403 日志盲区、vitest singleFork/globalTeardown 备忘）——本轮未发现上述项有新恶化，不再重复记录。

---

## 0. 静态门禁与实测基线

| 门禁 | 结果 |
|---|---|
| `bun run test`（vitest，node 运行时） | 68 文件 / **756/756 通过**（97.5s；752 + 4 个新锚点用例，数目自洽） |
| `bun --filter remote-reader-web check` | **0 错误** / 5 警告（均为 AGENTS.md 备案的有意快照/autofocus） |
| `bun --filter remote-reader-bridge check` | **0 错误** |
| `bun run build` | 成功（34.2s，adapter-node） |
| `scripts/e2e-check.sh`（隔离临时库实机） | 2/3 轮全绿；1 轮末段瞬态假红（→ R-15） |
| 标题锚点专项（实机上传 → `/s/` HTML 断言 + Playwright 真浏览器） | 重复标题去重 `-1` / CJK slug / 行内码 slug / 页内链接百分号编码解码后命中 / 点击滚动 + `tabindex=-1` 获焦——全部通过 |

---

## 1. 发现汇总

严重度标尺：**P0** 数据丢失/安全/停机；**P1** 现实场景正确性缺陷或显著误导性文档；**P2** 边缘正确性缺口 / 有意义的功能·UX 缺口 / 实际架构债；**P3** 打磨级。

| # | 维度 | 级 | 结论一句话 |
|---|---|---|---|
| R-01 | 功能性(文档) | **P1** | PRODUCT.md 把已上线的「标签 + FTS5 全文搜索」列为 Phase 3 规划中，功能清单整体停在 7 月 |
| R-02 | 正确性 | **P2** | 标题锚点 slug 排除 math_inline——含公式标题的 GitHub 惯例目录链接落空；纯公式/纯标点标题产出退化 id |
| R-03 | 用户体验 | **P2** | `/s/` 顶栏「← 返回我的文档库」对匿名阅读者是错误文案并通向登录墙 |
| R-04 | 功能性(文档) | **P2** | USER_GUIDE/README 特性清单未覆盖已交付的搜索、标签、最近文档/最近浏览视图、主题切换 |
| R-05 | 功能性(文档) | **P2** | INSTALL 反代示例 body 上限 8m 与图片中转体积（10MB 图 ≈ 13.7MB body）矛盾 |
| R-06 | 架构 | **P2** | RecentList ↔ FM 页行操作编排层约百行近似拷贝，且已发生行为漂移 |
| R-07 | 架构 | **P2** | documents.ts 789 行四职责混杂（超项目自定 250 行基准 3 倍） |
| R-08 | 正确性 | P3 | create 类表单失败分支静默（tokens/invites JS 路径无 failure 分支 + 三处 no-JS 无 form.error 渲染） |
| R-09 | 正确性 | P3 | 三类全屏查看浮层不参与 overlay-history——Android 返回键直接退出页面 |
| R-10 | 正确性 | P3 | rename 磁盘失败被路由映射为 404「文档不存在」 |
| R-11 | 架构 | P3 | install.sh ↔ update.sh 携带 rsync 清单 + 构建链逐字重复（lib-deploy.sh 共享面之外） |
| R-12 | 架构 | P3 | 测试 DATA_DIR 两套模式并存（mkdtemp 14 文件 vs `./data/test-*<ts>` 7 文件） |
| R-13 | 架构 | P3 | @types/node 跨 workspace 4 个 major 偏斜（22 vs 26） |
| R-14 | 架构 | P3 | +page.svelte `.doc-tags` 样式块重复声明 |
| R-15 | 功能性 | P3 | e2e-check.sh 末段 agent-guide grep 低频瞬态假红（1/3，根因未隔离） |
| R-16 | 功能性(文档) | P3 | 图片数量口径不一：README「≤50 张（服务端限流约束）」vs 工具描述「硬上限 500 张（413）」 |
| R-17 | 功能性(文档) | P3 | 文档杂项漂移组（语言数 38≠39 / `cd remote_reader` 拼写 / 英文报错引文 vs 中文实际报错 / 错误码表缺 409 / .env.example 重复行） |
| R-18 | 用户体验 | P3 | 生产 404/503 为 SvelteKit 框架默认错误页 |
| R-19 | 用户体验 | P3 | 冷文档同步拉取无页面级加载反馈 |
| R-20 | 用户体验 | P3 | FM/最近列表行内大小显示原始字节数（`2097152 B`） |
| R-21 | 用户体验 | P3 | 图片/Mermaid 放大视图入口键盘不可达 |
| R-22 | 用户体验 | P3 | 三个表单控件仅 placeholder 无 label/aria-label |
| R-23 | 用户体验 | P3 | 全站无 `prefers-reduced-motion` 处理 |
| R-24 | 正确性 | **P1** | 搜索摘要误用 FTS5 `highlight()`——每条命中携带**整篇文档正文**而非摘要 |
| R-25 | 正确性 | **P2** | 图片引用改写：同一 src 先出现于段落/标题、再次出现于表格时，表格处定位到首现行——真实行永不改写，残留本地路径 |
| R-26 | 正确性 | P3 | FM createFolder 不校验 parentId——悬空/伪造 dir 产出 UI 不可见孤儿 folder 行 |
| R-27 | 正确性 | P3 | 邀请码 note 无长度上限（与 MAX_TOKEN_NAME 卫生模式不一致） |
| R-28 | 正确性 | P3 | deleteNode 删文件夹后磁盘空目录树永久残留（全库无 rmdir） |
| R-29 | 架构(部署) | P3 | lib-deploy.sh 与 startup-check 公式两处语义微偏（奇数字节 floor / 小数回落；方向安全但注释声明过强） |
| R-30 | 架构(部署) | P3 | gen-unit.sh 实际加固指令 22 条 vs 文档声称「17 项」（计数漂移，无缺失） |
| R-31 | 用户体验(Agent) | P3 | api-client 413 硬编码文案丢弃服务端 message——图片超限时 Agent 拿不到具体上限值 |
| R-32 | 运维 | P3 | seed-token.mjs 对错误 DATABASE_PATH 静默创建空库后才报 no such table |
| R-33 | 运维 | P3 | install.sh 健康检查不通过仅 warn 且 exit 0（update.sh 是 die+回滚）；hostname 兜底链可达触发 |
| R-34 | 架构(部署) | P3 | .dockerignore 模式根锚定——`apps/web/data`（宿主 dev DB）与 `apps/web/.env` 被烤进 build stage |
| R-35 | 架构(部署) | P3 | uninstall.sh 危险路径守卫不含 CONFIG_DIR（SERVICE_NAME 误覆盖可 rm -rf /etc/\<name\>） |
| R-36 | 用户体验 | P3 | Mermaid 全屏快照不随主题切换刷新（auto 档系统翻转时可复现；inline 已刷新） |
| R-37 | 正确性 | **P1** | ImageLightbox 加载状态机在「idx 不变的 show()」上死锁——双击复位与单图图集滑动/方向键使图片永久不可见 |
| R-38 | 功能性(文档) | **P2** | Docker 快速开始「至少改」清单遗漏 BASE_URL + ORIGIN——照 README/INSTALL 字面操作 100% crash loop |
| R-39 | 架构 | P3 | RecentList `scrollRoot` prop 已死 + 效应注释误导（IO root 改视口的遗留） |
| R-40 | 用户体验 | P3 | 表格全屏 overlay 内的图片：点击不进 Lightbox、加载失败无裂图兜底（监听作用域限于 .markdown-body） |
| R-41 | 正确性 | P3 | 图片注册名含 `#`/`?` 时引用链永久断裂 + 上传字节被 GC 回收（命名校验域与引用归一化域不相交） |
| R-42 | 正确性 | P3 | 标签重命名允许逗号，而全部三个标签编辑入口以逗号为分隔符——含逗号标签在任何一次保存中被静默拆分 |
| R-43 | 正确性 | P3 | 图片注册名含 `%XX` 转义序列时引用链断裂（校验域=字面名，匹配域=解码名；R-41 同族不同机制，R-41 修复不覆盖） |
| R-44 | 运维 | P3 | seed-token.mjs 邮箱大小写/空白敏感——注册侧恒归一化，脚本侧裸匹配 |

零 P0。服务端核心不变量在三轮独立 trace 下全部成立（见 §3）。

---

## 2. 发现详情（最终结论 + 成因 + 证据）

### R-01 · P1 · 功能性(文档) · PRODUCT.md 把已上线功能列为规划中，功能清单停在 7 月

- **结论**：产品概览文档显著失真——已交付能力被标注为未实现，7 月后交付的九批特性全部缺席。
- **成因**：PRODUCT.md 自子计划 3（2026-07-19）后未随特性交付更新。
- **证据**：
  - `docs/PRODUCT.md:71-74`：`### 📋 规划中（Phase 3，低优先）` 下列 `- 文档标签 + FTS5 全文搜索`；`:91` 路线图 `| **Phase 3** | 远程 MCP server、标签、全文搜索、指定分享 | 📋 低优先级 |`
  - 实际已交付：`/search` 路由 + `settings/tags` 页 + tags 服务（spec `docs/superpowers/specs/2026-08-04-tags-search-design.md`，测试在 756 用例内）
  - §5「当前已实现」清单止于子计划 3，缺：标签/搜索（08-04）、最近文档视图（09-08）、最近浏览视图（09-12）、主题三档（09-13）、移动端 FM（09-14）、邀请码管理（09-14）、分享状态可视化（09-16）、Agent 自助接入（09-20）、图片支持（09-21）、标题锚点（09-26）
- **影响**：以产品概览评估能力的人会得出「搜索/标签还没做」的错误结论（状态事实性倒置）。

### R-02 · P2 · 正确性 · 标题锚点 slug 排除 math_inline token

- **结论**：新锚点特性（`5dc416f`）对含行内公式的标题生成与 GitHub 惯例不一致的 id——按 GitHub 惯例书写的目录链接落空；纯公式/纯标点标题产出退化 id。
- **成因**：`markdown-it-anchor@10` 默认 `getTokensText` 只收集 `text` + `code_inline` 两类 token 计入 slug；本项目 math 规则推送的 `math_inline` token（`packages/shared/src/markdown-math.ts:18`）不在其中，其 content 被整段丢弃；两侧 text token 的尾/首空格拼接形成连续双空格 → 双连字符。空串经 `GithubSlugger().slug('')` 返回 `''`，插件无条件 `attrSet("id", ...)` → `id=""`（HTML 规范要求 id 非空；第二个空 slug 去重为 `-1`）。
- **证据**：
  - `apps/web/src/lib/server/markdown.ts:109-111`：`md.use(anchor, { slugify: (s) => new GithubSlugger().slug(s) })`——未覆写 `getTokensText`
  - 插件 dist 源码：默认过滤 `["text","code_inline"].includes(e.type)`
  - 实机上传（生产构建、隔离库）实测输出：
    - `## 前 $x^2$ 后缀` → `<h2 id="前--后缀" tabindex="-1">`（GitHub 为 `前-x2-后缀`）
    - `## 求 $x$ 解` → `id="求--解"`（GitHub 为 `求-x-解`）
    - `## !!!` 两个 → `id=""` 与 `id="-1"`
  - 两路独立审查（源码级 + 实机级）收敛同一结论，复核亲证因果链
- **影响**：本产品自身即 KaTeX 渲染器、锚点特性的目的即「救活文档目录链接」——数学类标题上该目的仍缺口。频率低（标题含行内公式为少数形态），属边缘正确性缺口。
- **修复方向**（供后续参考）：`md.use(anchor, { slugify, getTokensText: (toks) => toks.filter(t => !['html_inline','image'].includes(t.type)).map(t => t.content).join('') })`——math_inline content 不含 `$` 定界，剥离后与 GitHub 逐字一致；空 slug 可在 `callback` 中跳过。

### R-03 · P2 · 用户体验 · `/s/` 顶栏「← 返回我的文档库」对匿名阅读者误导

- **结论**：免登录查看页唯一的导航入口按 owner 视角写死，对产品主受众（收到 IM 链接的匿名阅读者）是错误文案，点击后落入登录表单。
- **成因**：链接未按 load 已计算的 `ownerView` 区分受众。
- **证据**：
  - `apps/web/src/routes/s/[token]/+page.svelte:23`：`<a class="back" href="/">← 返回我的文档库</a>`（无条件渲染）
  - `apps/web/src/routes/+page.server.ts:20`：`if (!locals.user) redirect(302, '/login')`——匿名 `GET /` 实测 302 → /login
  - 同页 load 已返回 `ownerView`（`+page.server.ts:34`）但仅用于浏览上报 effect，未用于此链接

### R-04 · P2 · 功能性(文档) · USER_GUIDE/README 特性清单未覆盖已交付能力

- **结论**：用户手册的阅读者/文件管理器章节与 README 特性清单缺失四批已交付特性的任何记载。
- **成因**：手册 FM 章节停留在 09-16 批次，8-9 月特性未回写。
- **证据**：
  - `docs/USER_GUIDE.md` 全文 grep「最近文档 / 最近浏览」**0 命中**；§3.2 FM 功能列表（242-248 行）无搜索、标签、三视图、主题
  - 线上代码：顶栏搜索框 + `/search` 页、FM 三视图页签（`?view=recent|viewed`）、`ThemeToggle`（auto/light/dark）均存在
  - `README.md` ✨特性 清单同样未提（仅覆盖管理 UI 部分能力）
- **影响**：新用户无法从手册发现搜索/最近视图/主题等高频入口。

### R-05 · P2 · 功能性(文档) · INSTALL 反代示例 body 上限与图片支持矛盾

- **结论**：照抄 INSTALL §6 反代示例的部署，>8MB 的图片中转上传会被反代以 413 拦截（应用层看不到、无日志），而应用层默认配置允许 10MB 图片。
- **成因**：§6 写于图片支持（09-21）之前，示例数值与注释（仅提 `MAX_UPLOAD_BYTES`）未同步图片 base64 中转通道。
- **证据**：
  - `docs/INSTALL.md:225`：`client_max_body_size 8m;     # 须 > MAX_UPLOAD_BYTES`；`:242`：caddy `request_body { max_size 8MB }`
  - 图片 relay 走 base64 JSON：10MB 图 ≈ 13.7MB body；`startup-check.ts` 要求 `BODY_SIZE_LIMIT ≥ max(5M×1.5, ceil(10M×1.37×1.5)) = 21548237`（`.env.example:29-31` 明示 5M+10M 配 24M）
  - 应用层启动校验会放行该部署（BODY_SIZE_LIMIT 24M），但请求先被反代拦截——恰是 INSTALL 自己反复警告的那类「日志无痕」坑

### R-06 · P2 · 架构 · RecentList ↔ FM 页行操作编排层约百行拷贝且已漂移

- **结论**：两个视图各自维护同一套行操作编排（confirm → submitAction/fetch → 刷新 → 错误横幅），已出现单侧行为差异。
- **成因**：2026-09-16 分享可视化批的收敛止步于 fetch 层（`row-menu.ts` 菜单项 + `share-api.ts` 请求），其上的编排层留在两份。
- **证据**：
  - `apps/web/src/routes/+page.svelte:155-239` 与 `apps/web/src/lib/components/RecentList.svelte:127-213`：`doShare/doUnshare/doRename/doSetTags/doDelete/onRowAction` + `menuCtx` + ActionSheet/ActionMenu/ShareDialog 三件套各自实现；`doShare` 仅 `recentRef?.reSync()` 与 `reSync()` 之差，confirm 文案逐字相同
  - **漂移实证**：`RecentList.svelte` `doDelete` 成功分支有乐观移除 `rows = rows.filter((x) => x.id !== item.id)`（注释「终审跟进」），`+page.svelte` 同名函数没有——同一删除操作在两视图的呈现语义已不一致
- **成本**：删除/重命名语义变更必须双改，漏改即分叉——乐观移除漂移即先例，正是 row-menu 收敛要防的漂移类别在更高一层重演。

### R-07 · P2 · 架构 · documents.ts 789 行四职责混杂

- **结论**：全库最大服务模块超项目自定 250 行基准 3 倍，四个可分离职责簇同居一文件。
- **成因**：文档域聚合自然生长，多轮审查（squatter 锁序、翻转守卫、move 子树迁移）持续向同一文件叠加不变量。
- **证据**（`wc -l` = 789，第二大 +page.svelte 541）：
  - 树结构查询：`findNode/findSiblingByName/logicalSegmentsOf/parentChainIntact/collectSubtreeFiles`（48-196 行）
  - 上传管线 + 自愈：`migrateFileRow/evictStoragePathSquatter/uploadDocument`（154-384 行，单函数 140 行）
  - 树变更：`renameNode/moveNode/deleteNode`（508-728 行，moveNode 114 行）
  - 列表/读取/DTO：`toDocDTO/listChildren/recentFiles/readDocumentContent` 等
- **成本**：上传自愈不变量（历经 3 轮对抗审查的全库最审计密集代码）与无关读路径同文件，每次触碰都要求审阅者持有 789 行上下文。可拆 `upload.ts`（~230 行）与 `tree-ops.ts`（~220 行）。

### R-08 · P3 · 正确性 · create 类表单失败分支静默

- **结论**：三处「创建」表单的失败路径无任何可见反馈。
- **成因**：cycle-3 落地的「fail() + 前端 failure 分支 + no-JS form prop 渲染」标准覆盖了 revoke 类操作与 /d/[id]、settings/tags，create 路径漏网。
- **证据**：
  - `apps/web/src/routes/settings/tokens/+page.svelte:38-43`（invites 44-49 同款）：enhance 回调仅 `if (result.type === 'success')`，无 failure 分支；页面仅渲染 `form?.plaintext`（reveal），不渲染 `form?.error`
  - 服务端确实会 fail：`tokens/+page.server.ts:16` `fail(400, { error: '名称过长（≤100 字符）' })`
  - FM createFolder（`+page.svelte:287-295`）JS 路径有 failure 分支 ✓，但页面未消费 `form` prop——no-JS 提交撞 409/400 同样静默
- **影响**：粘贴超长 token 名（或 no-JS 提交）→ 按钮恢复可点、无提示，误以为功能故障。无数据损坏。

### R-09 · P3 · 正确性(一致性) · 全屏查看浮层不参与 overlay-history

- **结论**：Mermaid 大图 / 表格全屏 / 图片 Lightbox 三类全屏查看器未接入返回键编排——移动端按系统返回键直接退出整个文档页（丢失阅读位置），与同 App 内 sheet/抽屉/分享浮层「返回=关浮层」心智冲突。
- **成因**：overlay-history 模式（09-14 抽屉首创）逐浮层渐进推广；内容查看类浮层（先于该模式存在，重构时按「行为零变化」保留）与新 Lightbox（image spec 未对返回键做决策）均未接入。
- **证据**：grep 全仓 `overlay-history` 消费方仅 3 处——`+page.svelte`（抽屉）、`ActionSheet.svelte:21`、`ShareDialog.svelte`；`ImageLightbox.svelte`/`MermaidViewer.svelte`/`TableFullscreen.svelte` 零引用。Lightbox 是移动端高频主路径（点图即入）。
- **注**：桌面端零影响；spec 层面属未决策而非有意偏离（image spec「从简偏离」清单只列 swipe/双击/阻尼三项）。

### R-10 · P3 · 正确性 · rename 磁盘失败映射 404「文档不存在」

- **结论**：服务层 result 对象形状松散（`code` 可选），路由 else 兜底把磁盘故障报成「文档不存在」。
- **成因**：`renameNode` 返回 `{ ok: boolean; reason?; code?: 'not_found'|'conflict'|'invalid' }`，`moveNode` 多条失败分支（目标与自身相同/目标文件夹不存在/路径过深）不带 code，`createFolder` 则是 code 必填的判别联合——同族三种形状；路由只能按 `code === 'conflict'` 二分。
- **证据**：
  - `documents.ts:530`：磁盘 renameSync 失败 `return { ok: false, reason: '磁盘重命名失败', code: 'invalid' }`
  - `+page.server.ts:81-84`：`if (r.code === 'conflict') return fail(409, ...); return fail(404, { error: r.reason ?? '文档不存在' })`——`invalid` 落入 404
  - move 的同类 `invalid`（`documents.ts:631`）却映射 400——同因异果
- **影响**：消息文本正确（显示「磁盘重命名失败」）但状态码误导排障方向；属裁定明列的「result 形状不收敛」。

### R-11 · P3 · 架构 · install.sh ↔ update.sh 逐字重复块

- **证据**：rsync 排除清单 11 行完全相同（`scripts/install.sh:123-134` ↔ `scripts/update.sh:288-299`）；构建链（bun install → build → 剥离 devDeps → ABI 自修，约 20 行）近乎逐字（`install.sh:141-165` ↔ `update.sh:312-335`，仅 die 文案与变量提取方式不同）。
- **成因**：lib-deploy.sh 建立时只抽了公式/ABI/守卫三类函数，序列编排与 rsync 数据未进共享库；scripts/README 明言「勿在两个脚本里各写一份」。
- **成本**：新增 workspace 或改构建步骤需双改，漏一处即 install 与 update 部署出不同产物（与 BODY_SIZE_LIMIT 公式当年漂移同风险面）。

### R-12 · P3 · 架构 · 测试 DATA_DIR 两套模式并存

- **证据**：`mkdtemp(os.tmpdir())` 模式 14 文件（search/upload-api/storage/share-view/images-* 等）vs `./data/test-<名>-<时间戳>` + rmSync 模式（`tests/documents.test.ts:32`、`d-view:13`、`file-manager:13`、`fts/tiering/tiering-search/tiering-view` 等）——后者均有清理（`afterEach rmSync`），实测 `data/` 无累积。
- **成因**：2026-09-26 测试审查批只迁移了 4 个写默认路径的文件。
- **成本**：新测试作者面对两种范式随机选择；时间戳模式进程被杀时残留落在仓库 data/ 内。

### R-13 · P3 · 架构 · @types/node 跨 workspace 4 个 major 偏斜

- **证据**：`apps/web/package.json:20` 与 `apps/mcp-bridge/package.json:28` 均 `^22.0.0`，`packages/shared/package.json:19` `^26.1.1`。
- **成本**：shared 的 api-client 声明 `Buffer`（node:buffer 类型）在 26 版 types 下编译、消费方在 22 版环境下消费，types 语义差异可造成假绿/假红。

### R-14 · P3 · 架构 · `.doc-tags` 样式块重复声明

- **证据**：`apps/web/src/routes/+page.svelte:526` 与 `:540` 逐字相同：`.doc-tags { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0.25rem; }`。FM 多轮改造的编辑遗留；幂等规则，用户不可见。

### R-15 · P3 · 功能性 · e2e-check.sh 低频瞬态假红

- **结论**：冒烟脚本末段（登录页 agent-guide grep）出现 1/3 次失败：`curl -sf "$BASE/login" | grep -q 'id="agent-guide"'` 未命中，但服务端访问日志记录该次 `GET /login 200`（14:53:24.046）、无任何错误栈；事后同命令通过，第 2 轮（同库）与第 3 轮（全新冷库 + 冷服务 + 完全相同序列）均全绿。
- **成因**：未隔离（两次受控复现失败；怀疑首渲染 body 流在图片段负载下被截断或 curl 管道异常，服务端无 5xx 无错误输出）。
- **影响**：冒烟门禁偶发假红 → 误判/无谓重跑；无功能性缺陷证据。

### R-16 · P3 · 功能性(文档) · 图片数量口径不一

- **证据**：`README.md:113`（README.en.md 同）：`单文档 ≤50 张（服务端限流约束）`；`packages/shared/src/tools/upload-document.ts:16`：`单文档硬上限 500 张图（服务端强制，超过 413）`；服务端实况 `MAX_IMAGE_REFS=500`（image-extract.ts:7，413），relay 限流 60/min 且桥内置 429 退避重试×2（50-500 张会间歇 429 重试拖慢但可成功）。
- **成因**：50 是 relay 限流的保守建议、500 是 refs 硬上限，两个数字并存无交叉说明——README 的「（服务端限流约束）」附着在 50 上，读起来像服务端上限是 50。

### R-17 · P3 · 功能性(文档) · 文档杂项漂移组

- `docs/PRODUCT.md:59`「~38 语言」vs 实际 39（markdown.ts LANGS 计数；README 已写 39）。
- `docs/USER_GUIDE.md:14` `cd remote_reader`（下划线）vs INSTALL/README 的 `cd remote-reader`（GitHub 仓库名连字符）。
- `docs/USER_GUIDE.md:280` 与 `docs/INSTALL.md:382` 引英文报错原文 `SESSION_SECRET must be set in production`，实际报错为中文「SESSION_SECRET 生产环境必填」（`startup-check.ts:36`）——按文案搜日志搜不到。
- `docs/USER_GUIDE.md` §2.5 错误码表（222-228 行）缺 **409** 行（跨类型同名占用；api-client 特意透传 message 供 Agent 自愈，手册无此行）。
- `.env.example` `AUTH_FAIL_RATE_LIMIT_MAX` 同时以注释（27 行）与生效行（37 行）出现两次（纯观感）。

### R-18 · P3 · 用户体验 · 生产错误页为框架默认 fallback

- **证据**：`apps/web/src/routes/` 无 `+error.svelte`、apps/web 无 `error.html`（ls 证实）；`/s/[token]/+page.server.ts` `error(404, '链接已失效或不存在')` / 503「归档存储暂时不可达」——消息文案本身良好，生产 adapter-node 走框架极简页（无品牌/不随主题/无返回指引）。

### R-19 · P3 · 用户体验 · 冷文档同步拉取无加载反馈

- **证据**：`/s/`、`/d/` load 直接 `await readDocumentContent`（冷文档同步 S3 拉取），期间仅浏览器 tab 转圈；失败有 503 文案兜底。大文档慢链路回热时 10s+ 无上下文白屏等待。

### R-20 · P3 · 用户体验 · 行内大小显示原始字节数

- **证据**：`+page.svelte:375`、`RecentList.svelte:248` `<span class="size">{item.sizeBytes} B</span>`——`2097152 B` 可读性差；时间列有 `formatRelative` 精修，大小列形成反差。

### R-21 · P3 · 用户体验 · 图片/Mermaid 放大入口键盘不可达

- **证据**：`MarkdownViewer.svelte:26` 正文图开 Lightbox 走 click 事件委托（img 无 tabindex/role/keydown）；`MermaidViewer.svelte` `.rr-mermaid-inline` 为 div+click（title 提示但不可聚焦）。浮层自身键盘支持完备（Esc/←→/+−/Tab trap）；表格 ⛶ 是真 `<button>` 可达。键盘用户打不开图片/图表放大视图。

### R-22 · P3 · 用户体验 · 三个表单控件仅 placeholder 无 label

- **证据**：`settings/tokens/+page.svelte:44`（name）、`settings/invites/+page.svelte:49`（note）、`search/+page.svelte:21`（q）均无 aria-label（对比：topnav 搜索框与 invites 的 select 有）。屏幕阅读器读到无名输入框。

### R-23 · P3 · 用户体验 · 全站无 prefers-reduced-motion

- **证据**：`apps/web/src` 全量 grep 0 命中；存在 drawer/sheet 滑入（180ms）、树 fade（80ms）、lightbox fadein 动画。均短促非核心，记打磨级。

### R-24 · P1 · 正确性 · 搜索摘要误用 `highlight()`——每条命中携带整篇文档正文

- **结论**：搜索结果的「摘要」实为 FTS5 `highlight()` 输出——该函数返回**整列原文插标记**，从不截断；每条命中（≤50 条）的响应与 SSR 页面携带完整文档正文。
- **成因**：辅助函数选错——`snippet()` 才是截断版；`safeSnippet` 只做转义+标记替换无长度控制；现有测试夹具均为几十字短文（短文下「全文==摘要」），测试恒过无法拦截。
- **证据**：
  - `apps/web/src/lib/server/search.ts:69-75`：`SELECT d.id, highlight(docs_fts, 2, char(57344), char(57345)) AS raw ... LIMIT 50`
  - `apps/web/src/routes/search/+page.svelte:63-64`：`{#if r.snippet}<p class="snippet">{@html r.snippet}</p>`——`.snippet` 样式仅字号（96 行），无 CSS 截断
  - **实测**（仓库捆绑 better-sqlite3，:memory: 只读实验）：content 长 6007 → `highlight()` 长 **6020**（全文+标记），`snippet(...,32)` 长 48
- **影响**：默认单文档上限 5MB——搜常见词时搜索页变成最多 50 篇全文拼接，页面卡死、SSR 内存/CPU 线性放大。附带不一致：名称命中（热文档）的 snippet 为无标记全文、LIKE 兜底路径（<3 字查询）snippet 恒空——三路形态各异，印证「摘要」契约从未成立。
- **修复方向**：改用 `snippet(docs_fts, 2, char(57344), char(57345), '…', 32)`（SQL 层截断），补大文档断言（snippet ≤ N 字符）。

### R-25 · P2 · 正确性 · 同一本地图片先出现于段落、再次出现于表格时，表格处引用不被改写

- **结论**：桥的图片引用改写（`rewriteImageRefs`）只处理 token 定位到的行；表格 cell 的 inline token 无 `.map`，行定位退化为**全文首次出现匹配**——同 src 先前已出现（或路径串被文本提及）时表格 token 被定位到首现行，表格真实行永不进入改写集合。
- **成因**：行定位的两级策略（父 map 范围优先 → 全文 findIndex 兜底）都无法区分同 src 的多次出现；兜底取首个命中行。表格上下文（map=null）完全依赖兜底。
- **证据**：
  - `packages/shared/src/image-extract.ts:68-86`：`lineOf` 的 range 命中与 `lines.findIndex(hit)` 兜底均为首次出现语义；`walk` 对 map-less inline 不重置 parentMap（且该陈旧范围与兜底**结果等价**——两者都返回首现行）
  - `packages/shared/src/tools/image-pipeline.ts:153-176`：`lineSrcs` 按 token 行建集，逐行 `replace`——未进入集合的行原样保留
  - 实测（bun 直跑源码）：`![a](pics/dup.png)\n\n|x|\n|---|\n| ![b](pics/dup.png) |` → 两 token 均定位 line 0，改写后表格行 `![b](pics/dup.png)` 原样残留（rewrites=1）
- **影响**：图片字节已上传但表格内引用残留本地路径——路径形 src（含 `/`）渲染裂图，且 `upload-warnings` 判为可疑引用返回「桥版本过旧」警告，**误导 Agent 升级本是最新版的桥**；裸名 src 在文件名含空格（sanitize 成 `-`）或撞名改 `-2` 时裂图。触发面：同图引用 ≥2 次且第 2+ 次在表格内（段落→表格/标题→表格/表格→表格均中招；表格→段落不中招——后续段落自带 map）。
- **修复方向**：行定位需区分同 src 多次出现（按出现序号匹配 token ↔ 行），或改写集合按「含该 src 任一形态的所有行」构建（注意会连带改写代码段内的文本提及，需权衡）。仅重置 parentMap 为 null **不足以修复**（兜底同为首次出现语义）。

### R-26 · P3 · 正确性 · FM createFolder 不校验 parentId

- **证据**：`apps/web/src/routes/+page.server.ts:54-56`（`dir` 取 URL 直作 parentId）+ `documents.ts:386-415` `createFolder` 仅做同名查重，不验证 parentId 存在、属本人、且为 folder——对照 `moveNode:559-567`（target 必须 `type='folder'` 且 owner 匹配），createFolder 是 FM 五 action 中唯一缺口。
- **影响**：现实触发——双标签页，A 删目录、B 陈旧页新建子文件夹 → 静默成功但 folder 永久不可见（`folder-tree.ts` 孤儿父链不渲染）、无 UI 可清理；伪造请求亦然（仅自伤，无越权/无崩溃）。

### R-27 · P3 · 正确性 · 邀请码 note 无长度上限

- **证据**：`settings/invites/+page.server.ts:24-26` 仅 `if (!note)`；对照 `apitokens.ts:6` `MAX_TOKEN_NAME=100` 双入口共用（2026-09-20 卫生批次），同批次 invite note 漏掉。admin-only 自伤面。

### R-28 · P3 · 正确性 · deleteNode 磁盘空目录树残留

- **证据**：`documents.ts:708-724` 仅对 file 行 `rmSync(f.storagePath)`；folder 对应目录无 rmdir，全库 grep `rmdir` **0 命中**。长期部署在 `data/<owner>/` 累积空目录（无功能影响，writeFile mkdir recursive 兼容已存在目录）。

### R-29 · P3 · 架构(部署) · lib-deploy.sh 公式两处语义微偏

- **证据**：`scripts/lib-deploy.sh:8-30` vs `startup-check.ts:88`：
  1. `a=$((upload*3/2))` 向下取整 vs JS `upload*1.5` 精确值——MAX_UPLOAD_BYTES 为奇数字节且 BODY_SIZE_LIMIT 恰等于 bash 下限时，update.sh 判「不小于」跳过迁移而服务端 `limit < need`（差 0.5）拒启 → 健康失败回滚后重跑仍跳过，理论永久卡死（现实 env 值均规整，极边缘）。
  2. `parse_size_bytes` 小数值（如 `20.5M`）回落 524288 触发一次不必要迁移（有备份、方向安全）；注释「与启动校验的兜底一致」不准确——startup-check 对非空非法值是 NaN fail-fast 而非 512K 兜底。

### R-30 · P3 · 架构(部署) · gen-unit.sh 加固计数漂移

- **证据**：`scripts/gen-unit.sh:46-80` 逐条清点实际加固指令 **22** 条（+3 条资源上限 + 显式 `MemoryDenyWriteExecute=no` 有意关闭），AGENTS.md / scripts/README / gen-unit 自身注释均声称「17 项」。少报方向无害、无缺失指令，纯计数漂移。

### R-31 · P3 · 用户体验(Agent) · api-client 413 丢弃服务端 message

- **证据**：`packages/shared/src/api-client.ts:47-48` `case 413: return '内容超过大小上限'`——服务端图片 init 413 的 wire body 是 `{"message":"图片超过上限（10485760B）"}`；桥侧护栏 50MB，10–50MB 图片过预检后在 init 处 413，动态上限数值被硬编码文案替换（400 分支透传 message、413 不透传，映射表内部不一致）。

### R-32 · P3 · 运维 · seed-token.mjs 错误路径静默建空库

- **证据**：`scripts/seed-token.mjs:16-17` `new Database(dbPath)`（better-sqlite3 默认创建不存在的文件）→ `SELECT ... FROM users` 抛 `no such table: users` 原始栈，遗留 0 字节垃圾 db 文件；排障方向被带偏（看似迁移缺失，实为路径指错）。

### R-33 · P3 · 运维 · install.sh 健康检查失败仅 warn 且 exit 0

- **证据**：`scripts/install.sh:231-240` 15s 轮询失败只 `warn` 后继续打印成功总结、退出码 0（对照 `update.sh:414-421` die→trap 回滚）；可达链：`:81` `hostname -I` 无非 loopback IPv4 时 BASE_URL 兜底 `http://localhost:${PORT}` → 生产启动校验「BASE_URL 不可指向本地地址」拒启 → crash-loop 而脚本仍报成功——自动化/CI 依 exit code 误判。

### R-34 · P3 · 架构(部署) · .dockerignore 根锚定漏 apps/web/data 与 apps/web/.env

- **证据**：`.dockerignore` 的 `node_modules`/`**/node_modules` 对嵌套目录用 `**/` 前缀，而 `data`、`.env*` 为根锚定——不匹配 `apps/web/data`（宿主实存，含 app.db）与 `apps/web/.env`；`Dockerfile:13-15` 先 `COPY apps apps` 再 build，且作者注释自证「vite build evaluates db/index.ts (top-level new Database())」——build 打开的是宿主 dev DB 拷贝。
- **影响**：构建非确定性/膨胀；dev server 运行中构建时拷贝 mid-write DB（含 -wal）理论上可致 SQLITE_NOTADB 假失败。**敏感物不进最终镜像**（项目无 VITE_* 用法、runtime stage 只拷 node_modules+build），故 P3。

### R-35 · P3 · 架构(部署) · uninstall.sh 守卫漏 CONFIG_DIR

- **证据**：`scripts/uninstall.sh:74-78` 守卫覆盖 SERVICE_NAME/INSTALL_DIR/DATA_DIR/LOG_DIR 四项；`CONFIG_DIR=/etc/${SERVICE_NAME}`（:21）直接进 `:136` `rm -rf "${INSTALL_DIR}" "${CONFIG_DIR}"`——`SERVICE_NAME=nginx` 误覆盖时可删 `/etc/nginx`。需操作者显式 misconfig 才触发，默认路径安全；与同函数守卫哲学不一致。

### R-36 · P3 · 用户体验 · Mermaid 全屏快照不随主题切换刷新

- **证据**：`MermaidViewer.svelte:69` 点击时快照 `fullscreen = { svg: wrap.innerHTML, ... }`；`:74-91` `rerenderOnTheme()` 仅重渲 `.rr-mermaid-inline`，`:138-145` MutationObserver 也只触发它——fullscreen 状态不被触碰。mermaid 主题色是 SVG 内联字面量（非 CSS 变量）。
- **影响**：浮层外壳即时换档但图内容保持旧主题；触发路径窄（modal + focus trap 使 ThemeToggle 不可达，现实触发仅 **auto 档跟随系统实时翻转**发生在查看大图期间）。TableFullscreen 无此问题（克隆的是 class + var() 引用，活主题）。

### R-37 · P1 · 正确性 · ImageLightbox 加载状态机死锁（idx 不变的 show()）

- **结论**：`show()` 将 `loading=true / imgLoaded=false`，唯一复位出口是 img 元素的 `load/error` 事件；当 show() 参数取模后 idx 不变时（`{#key idx}` 值相同 → 不重建元素、src 不变 → 浏览器不再派发 load），状态机无出口——图片永久 `opacity:0` 不可见 + spinner 常转。
- **成因**：加载状态机假设「每次 show() 都伴随元素重建」；两条路径违背该假设。
- **证据**（`apps/web/src/lib/components/ImageLightbox.svelte`）：
  - `:34-42` `show()` 尾部 `loading = true; imgLoaded = false;`（注释「切图重置（spec：每图独立状态 100%）」）
  - `:118-130` `onDblClick` else 分支（zoom>1 再双击复位）调 `show(idx)`——idx 不变
  - `:198-215` `{#key idx}` + `class:loaded={imgLoaded}` + `onload/onerror={onImgSettled}`——Svelte key 块仅在值变化时重建
  - `:28-31` 注释自证「图集切换时 loading=true，img onload/onerror 置 false」——事件源穷举封闭
- **触发路径**（均现实高频）：① 任意图集双击放大到 2.5x 后**再双击复位**（通行 toggle 语义且代码明确实现复位意图）→ 图片淡出 + 无限 spinner；② 单图文档（最常见图集规模）←/→ 方向键或 1x 单指横滑 → `(n±1)%1 === idx` → 同样死锁，且无「切图自愈」路径，只能关闭重开。
- **影响**：核心查看交互触发后主内容不可见；多图可切图自愈、单图不能。`scripts/e2e-images.mjs` 只测了 zoom===1 的双击放大与 idx 变化的切图，复位/单图两条路径无覆盖（与缺陷存活互洽）。
- **验证**：代码级全路径推演 + 事件源穷举（未实机浏览器复现；修复时建议补「双击复位」「单图方向键」两条 Playwright 断言）。
- **修复方向**：idx 未变化的 reset 路径不重置 loading/imgLoaded（或将 `show` 拆为 `resetView()` 与 `switchTo(n)`），或对 img 加 `src` 重赋值/`decode()` 主动触发 settled。

### R-38 · P2 · 功能性(文档) · Docker 快速开始最小必改集遗漏 BASE_URL + ORIGIN

- **结论**：照 README/INSTALL 的 Docker 快速开始字面操作（`cp .env.example .env` + 只改 SESSION_SECRET、INITIAL_INVITE_CODE + `docker compose up`），容器 100% crash loop。
- **成因**：ORIGIN/BASE_URL 生产校验（2026-09-15/23 批次）加入后，Docker 路径的「至少改」指引未同步——最小正确操作集实为四项（SESSION_SECRET、INITIAL_INVITE_CODE、BASE_URL、ORIGIN=BASE_URL 同值），文档只列两项。
- **证据**（全链）：
  - `README.md:52` / `README.en.md:52`：`cp .env.example .env  # 至少改 SESSION_SECRET、INITIAL_INVITE_CODE`；`docs/INSTALL.md:88`「至少改这两项」（§3.1 可选块更把 BASE_URL 列为可选）
  - `.env.example:3` `BASE_URL=http://localhost:5173`（dev 值）；`:5` `ORIGIN=https://your-host`（与任何 BASE_URL 都不同源的占位值）
  - `docker-compose.yml:11` `NODE_ENV=production` + `Dockerfile:37` `ENV NODE_ENV=production` → 生产校验全链生效；entrypoint 无兜底
  - `startup-check.ts:60-62`：`hostname === 'localhost' | '127.0.0.1' | '0.0.0.0' | '::1'` → throw「BASE_URL 生产环境不可指向本地地址」；`:80-82`：`originUrl.origin !== baseUrl.origin` → throw「ORIGIN 与 BASE_URL 不同源」
- **影响**：构建成功但容器启动即 crash；即便用户改了 BASE_URL，`.env.example` 的 ORIGIN 占位值仍触发不同源校验。缓解：报错文案自描述（指明改法）、无数据/安全面影响；systemd 路径不受影响（install.sh:187-188 自动写 `ORIGIN=${BASE_URL}`）。

### R-39 · P3 · 架构 · RecentList `scrollRoot` 死 prop + 注释误导

- **证据**：`RecentList.svelte:21,30`（props 声明）、`:218` 注释「依赖仅 scrollRoot/sentinel」——实际 effect 体内只读 `sentinel`；`+page.svelte:334,346` 仍传 `scrollRoot={rightPane}`。全 src 树 grep 仅 5 处命中、无真实消费。
- **成因**：2026-09-15 修复把 IO root 从右栏元素改为视口（null）时删掉了消费点，prop 与传参残留。无行为影响；注释声称的依赖关系与代码相反，易误导后续维护。

### R-40 · P3 · 用户体验 · 表格全屏 overlay 内图片无 Lightbox、无裂图兜底

- **证据**：`MarkdownViewer.svelte:15-28`（lightbox click 委托挂 `container`=.markdown-body）、`:31-46`（error capture 兜底同挂 `container`）；组件模板结构（`:70-77`）中 `TableFullscreen` 与 `.markdown-body` div 平级——overlay 渲染于容器子树之外。
- **影响**：宽表内的图片在全屏查看模式下不可点击放大（内联态可以）、CDN 直连失败时无 `rr-img-missing` 占位反馈。低频组合（图在表内 + 进全屏查看）。

### R-41 · P3 · 正确性 · 图片注册名含 `#`/`?`：引用链永久断裂 + 字节被 GC 回收

- **结论**：图片命名校验（`validateInitInput`）允许 `#`/`?`，而引用归一化（`normalizeImageRef`）在 `?#` 处截断——两者对「合法名」的判定不相交。本地文件名含这两个字符时经桥上传后，图片**永远**渲染为裂图占位、refs 永不登记、24h 后字节被周期 GC 物理回收，重试无法自愈（init 按 hash 命中 `exists` 仍返回同名）。
- **成因/证据**（五环全部亲证，markdown-it 行为经 node 实测）：
  1. 桥 `image-pipeline.ts:110` 用 `basename(decodeLocalSrc(src))` 作注册名；实测 markdown-it 对 `![a](a#b.png)` 的 attr src **保留字面 `#`**（`a?b.png` 同）；`sanitizeImageName` 仅替换空格；`images.ts` `validateInitInput` 拒绝 `/` `\` `.` `..` 控制符/超长，**不拒 `#`/`?`** → 行以 `a#b.png` 注册成功
  2. `rewriteImageRefs`（image-pipeline.ts:147-176）把注册名**原样**写回 markdown（`match.get(m)` 无编码）→ 恒等替换，rewrites 计数照加
  3. 服务端 `normalizeImageRef`（image-extract.ts:27-28）`search(/[?#]/)` 截断 → 提取名变 `a`
  4. `registerDocumentRefs` 按名 `a` 解析 → 无该行 → refs 未登记；渲染 `resolveImages` 同样解析 `a` → null → 输出裂图占位（名字还被截断成误导性的 `a`）
  5. 行 ready 但零 refs → GC 24h 软删 + 反查删 blob；重传同文件 init 命中 `exists` 仍返回 `a#b.png` → 死循环，唯一出路是本地改名
- **附带**：`upload-warnings` 判该引用未登记 → 附带输出误导性「桥版本过旧」警告（与 R-25 同表象、**不同根因**——R-25 是行定位首次出现语义，本条是命名校验域与归一化域分歧）。
- **影响/定级**：单图裂 + 该图字节被回收 + 不可重试自愈；无安全面（storageKey 是 hash 寻址，名字不触存储路径）。触发需文件名含 `#`/`?`（比 R-25 更窄），定 P3；因「永久性 + 字节回收」可 argue P2，留 triage。
- **修复方向**：`validateInitInput` 拒绝含 `#`/`?` 的注册名（与归一化域对齐，单点收口；桥侧预检同步列 problem），或 `sanitizeImageName` 将两字符替换为 `-`。

### R-42 · P3 · 正确性 · 标签重命名允许逗号，标签编辑保存时被静默拆分

- **结论**：`sanitizeTagName` 只拒「空 / >32 / 含 `/`」，逗号合法——标签可被改名为 `v1,final`；而全部三个标签编辑入口以逗号连接预填、两个 setTags 写入方按逗号切分，`setDocTags` 为全量替换语义——含逗号标签在任何一次标签保存中被静默替换为两个新标签。
- **证据**（四站点全亲证）：
  1. `tags.ts:55-58` `sanitizeTagName`：`if (!n || n.length > MAX_TAG_NAME || n.includes('/')) return null`——无逗号拒绝；settings/tags rename action 无附加限制
  2. 三个预填点全部 `join(', ')`：`d/[id]/+page.svelte:29`、FM `+page.svelte:385`（`initialValue={tagInput || …join(', ')}`）、`RecentList.svelte:133`
  3. 两个写入方全部 `raw.split(',').map(trim).filter(Boolean)`：`+page.server.ts:115`、`d/[id]/+page.server.ts:38`
  4. `tags.ts:93-107` `setDocTags` 全量替换（先删不在目标集的关联）——切分结果即最终态
- **成因**：renameTag 的校验域与 setTags 的序列化域不相交——逗号是唯一能进入标签名、却无法在编辑表单中存活的字符（R-41 缺陷族成员）。
- **影响**：改名含逗号成功（无提示）后，任一已打该标签的文档打开标签编辑→保存（哪怕只想加别的标签），`v1,final` 被静默替换为 `v1`+`final`，逐文档蔓延；标签行本身不丢（settings 可见、可手动补救）。
- **修复方向**：`sanitizeTagName` 增拒 `n.includes(',')`，FM/`d/[id]` 两个 action 行内校验同步。

### R-43 · P3 · 正确性 · 图片注册名含 `%XX` 转义序列：引用链断裂（R-41 同族不同机制）

- **结论**：`validateInitInput` 校验**字面名**，`normalizeImageRef` 按**解码名**匹配——注册名含百分号转义序列（`%20`/`%25`/`%2F`/`%23`/`%3A`…）时解码后 ≠ 字面名（或直接 null），引用链断裂，后果与 R-41 完全同构（refs 不登记 → 渲染裂图 → GC 24h 回收字节 → 重试 `exists` 同名死循环 + 误导性「桥版本过旧」警告）。
- **证据**（双侧实测）：
  - markdown-it 实测：`![x](a%20b.png)` 等 attr src **原样保留** `%XX`（合法转义不重编码；对照孤立 `%` 才被编成 `%25`）
  - 归一化实测：`a%20b.png`→`'a b.png'`（≠DB 名）、`a%25b.png`→`'a%b.png'`（≠DB 名）、`a%2Fb.png`→`null`（解码出 `/`）、`a%3Ab.png`→`null`（解码出 scheme）；`100%.png`→`'100%.png'`（安全边界——cycle-4「`%` 名往返成立」结论仅对此形态成立）
  - `images.ts:31-35` `validateInitInput` 拒集不含 `%` 序列
- **与 R-41 的边界**：R-41 是字面 `#`/`?` + 截断机制；本条是 `%XX` + 解码机制。**R-41 的修复（拒 `#`/`?`）对本条无效**。
- **影响**：直接 API 用户（README 手写 curl 路径）文件名含 `%20` 等（网页下载件常见）→ 永久裂图；桥路径大概率 fail-fast 自护（`decodeLocalSrc` 同样解码 → 预检「文件不存在」，报错指向解码后的文件名、具误导性但无数据损失）。
- **修复方向**：与 R-41 一并收口——`validateInitInput` 增加 `normalizeImageRef(sanitizeImageName(name)) !== name` 即拒（归一化不动点作为合法名判定，一次覆盖 `#`/`?`/`%XX`/scheme 全族）。

### R-44 · P3 · 运维 · seed-token.mjs 邮箱大小写/空白敏感

- **证据**：`registration.ts:25` 注册恒 `input.email.trim().toLowerCase()`（DB 邮箱恒小写无空白）；双登录入口同款归一化（cycle-2 已锁）；而 `scripts/seed-token.mjs:17` `WHERE email = ?` 直吞 `process.argv[2]` 无归一化。
- **影响**：`node scripts/seed-token.mjs Bob@Example.com` → 「user not found」误导排障（用户实际存在）。响亮失败、可自纠；与 R-32 同脚本不同缺陷。
- **修复方向**：脚本内一行 `email.trim().toLowerCase()`。

---

## 3. 审查通过面（重点核清项摘录）

### 3.1 标题锚点特性主体（本轮重点，新代码）
- 服务端：`markdown-it-anchor@10` 去重注册表挂 per-render `env.markdownItAnchor.slugs`（`md.render(src)` 不传 env → 每次全新），单例 md 实例跨文档 id **零漂移**（dist 源码 + 二次渲染实证）；`slugify` 单参调用、`-1` 后缀插件侧产出 = GitHub 风格；id 经 markdown-it `renderAttrs` escapeHtml 转义，`<script>`/引号标题实证无法注入；blockquote/列表内标题正常锚定；与图片占位符替换零交互（core 期属性 vs render 期 src）；RENDER_CACHE 按 contentHash 确定性复用；math_block/mermaid 为块级 token 不受影响。
- 客户端：SvelteKit 2.70 路由源码核读 + Playwright 真浏览器实测——同页 hash 点击不拦截（浏览器原生滚动 + history 条目）、同 hash 点击 `scrollIntoView()+focus()`（CJK id 经 `decodeURIComponent` 后 `getElementById` 可用）、跨页 deep-link `scrollIntoView()`；页内 `[x](#slug)` 链接 href 百分号编码经浏览器解码后与 id 原文匹配（实测 3/3）；异步增强（mermaid/表格测量/katex）引起的锚点上方位移由浏览器 scroll anchoring 兜底，与 GitHub 同类。
- 回归面：FTS 索引吃 markdown 原文不吃渲染 HTML；搜索摘要走 FTS `highlight()` 不涉渲染；渲染 HTML 唯二消费者 `/s/`、`/d/` 测试均已适配；e2e-check 无 `<h` 断言无漂移。

### 3.2 服务端核心不变量（全部在位）
- 上传主流程：squatter 自愈在 attempt 循环顶、占位行自身 doc 锁内单独进行（调用点不持其他 doc 锁）；落库前父链存活复查；覆盖翻转守卫带 name+parentId 条件；UNIQUE 撞索引回壳层重试；幂等分支零副作用；跨类型同名提前 409。
- moveNode：BFS 收集 + hot 行物理迁移在事务外、事务内纯 DB 重对齐（嵌套 indexDoc = savepoint 合法）；双向回滚；cold 行仅改指针。
- tiering：archive 锁内重取行 + 冷判定复查 + hash 完整性 + storagePath 翻转守卫 + FTS 同事务 + 孤儿清理；rewarm 对称；坏候选 24h 暂缓；backfillFts 灌入前热态复核。
- images：init/relay/confirm 三环字节绑定（init 报称 ↔ relay 实测 sha256 ↔ confirm ETag==md5）；校验链 size→sha256→magic→ext；删行仅在字节真值之后；GC ready 窗口 NOT EXISTS 相关子查询下推 SQL + 确定性分页；R1 事务内集合差；direct 通道孤儿对象反查回收；S3 双 WHEN_REQUIRED 钉住、getRange 闭区间封口。
- 认证：bootstrap 码 sha256+timingSafeEqual；403 先于 409 不泄漏邮箱；核销与建用户同事务；登录 dummy hash 时序恒定；session HMAC+过期校验。
- db：SCHEMA_SQL ↔ schema.ts 逐表逐索引等价；keyset 两索引与三处查询形状对齐（row-value 比较）；foreign_keys=ON/busy_timeout=5000/WAL。
- ratelimit：17 个调用点桶键核对无漂移；限流回收在位。

### 3.3 前端与安全面
- `{@html}` 全站 4 处均受信输入（服务端 html:false 渲染 / mermaid strict SVG / 服务端 DOM 克隆 / search snippet 经 `safeSnippet` 转义仅注入字面 `<mark>`）。
- 全仓唯一 fetch-to-action 在 `form-action.ts submitAction`（fail 200 信封解包正确）；`/logout` 是 +server.ts endpoint，raw fetch 语义安全。
- overlay 编排：push/consume/markConsumedByPop 幂等；body-scroll 引用计数闭合（sheet→抽屉接力 1→2→1→0）；SvelteKit pushState 浅条目走 kit 'shallow' 分支。
- 主题：theme.css 双档变量 36:36 零差集；组件引用变量全部有定义；全站零硬编码色回漏。
- 模块边界：lib/server 无客户端泄漏；web 客户端 bundle 只拉 shared 浏览器安全模块；桥零 apps/web 引用。
- 单源裁定全部成立：BODY_SIZE_LIMIT 公式两处同语义、gen-unit 单源、extractImageNames 三方单源、row-menu/share-api 单源、submitAction 单源、folder-tree 单源、env getter 模式。

### 3.4 门禁
756/756 测试通过；svelte-check 0 错（5 警为备案有意项）；桥 tsc 0 错；build 成功；e2e-check 全链路（含图片七段、锚点专项）2/3 全绿。

---

### 3.5 Cycle-2 补充核清面（盲区定向 + 对抗复检）
- **FM 五 action / tags 服务 / apitokens + settings 四路由**：输入校验、owner 校验、fail() 语义全分支过；better-sqlite3 全同步 ⇒ 单进程 action 原子无双插竞态；reveal-once 仅存哈希；admin 门 load+action 双覆盖；tag 孤儿不自动清理为设计选择（settings 手工管理，docCount 透出）。
- **login/register（form）vs JSON 三端点**：同 registration.ts 核心、同限流键同桶、归一化先于限流键构造；登录时序恒定双入口同享；注册 403 先于 409、核销与建用户同事务（tx 回调全同步）、UNIQUE 兜 409；无 returnTo 为一致无此功能。
- **迁移 0000-0008 ↔ schema.ts ↔ ensureSchema**：逐列逐索引比对一致（默认值/可空性/索引名与列序/COALESCE 表达式三表示征）；0008 backfill 由运行时 ensureSchema 兜底；迁移路径再启动全 IF NOT EXISTS 幂等。
- **search FTS SQL**：MATCH 全参数化 + phrase 包裹（内引号 doubling，无注入面）；LIKE `ESCAPE '\'`；owner 过滤四路齐备；name LIKE 限 file；tag HAVING 为 AND 语义；`safeSnippet` 转义先于 mark 替换（PUA 碰撞仅装饰性，无 XSS）；highlight 列号 2=content 正确（唯 R-24 截断缺失）。
- **object-store-errors**：mapGetError 双路 404 归类（NoSuchKey + httpStatusCode 兜非标准网关）覆盖 Get/Head；put/delete 统一 503 正确；`!body` 防御分支在位。
- **session/crypto**：验签先于 JSON.parse；绝对过期与文档语义一致；logout 清 cookie 为无状态 HMAC 既定语义（撤销=换 SESSION_SECRET）。
- **/api/view + /api/recent**：游标 `<ts>_<id>` 三段校验（非数字/空段 400）；`^\d+$`+parseInt 杜绝行值 text/integer 存储类错比；owner_viewed_at 全库唯一写入方 markOwnerViewed（从不置 null）。
- **桥 + shared + 脚本**（逐行）：bridge 三文件接线/错误信封/env-file 优先级/版本双形态全对；image-pipeline 预检一次性全列、init 三态与客户端假设完全收敛、429 退避、部分失败语义（内容寻址重试复用、孤儿图 GC 回收）、putImageBytes 零头；paths.ts 对抗面全拒/全过正确；semver/image-mime 与文档一致；e2e-check 断言非空洞且重跑幂等；e2e-images 11 断言与声称一一对应；gen-unit 加固指令逐项齐全（唯计数漂移 R-30）；lib-deploy 四函数与双入口守卫覆盖（唯公式微偏 R-29）；bridge tsc 0 错实跑。
- **Cycle-1 通过面 10 项声明对抗复检全部 HELD**：submitAction 唯一 fetch-to-action、{@html} 4 处受信（含 innerHTML 3 处全受信、无 eval/document.write）、squatter 锁序（三分支追踪）、body-scroll 引用计数（consume 幂等 + action destroy unmount-safe + 原生 modal 阻断外部交互）、viewed 游标恒数字、Shiki fallback 双档可读 + 替换阶段在缓存外、邀请核销同事务、bootstrap 恒时比较（hex64 恒长）、限流桶键五组抽样无漂移（login 双入口归一化次序一致）、SCHEMA_SQL ↔ schema.ts 逐列逐索引等价。
- **Docker/部署**：Dockerfile 分层缓存序/非 root/runtime 无 bun/healthcheck 语义正确；compose 卷覆盖 DB+文档+local 图片后端（`blobstore-local` 根在 DATA_DIR 下）、environment 优先级钉 PORT；entrypoint bash+pipefail/find 增量 chown/降权；uninstall 逆操作完整（--purge 双确认、userdel 不带 -r）。
- **跨特性交互六对**：recent/viewed×move/rename（列写入面+FTS name 同步）、shared×冷热分层（tiering 零 share_links 写入）、invites×限流（429 先于校验、核销 tx 绑定）、theme×表格全屏（var() 活主题）、anchors×snippet（FTS 吃原文、safeSnippet 封闭注入集）、mobile FM×beacon（卸载重挂全量重排）——全部核清（唯 Mermaid 全屏快照 R-36）。

---

### 3.6 Cycle-3 补充核清面（收敛验证轮）
- **组件内部逐行**（此前仅单轮覆盖）：MarkdownViewer（三 effect 监听配对拆除/katex JS+CSS 同步懒加载/裂图 onerror 幂等）、MermaidViewer（观察器清理/Enter target 守卫/rrDone 幂等/渲染失败回退）、TableFullscreen（测量-恢复同步无窗口/RO 配对/html 切换全量重置）、ImageLightbox（滚轮锚定补偿与 normalizeOrigin 数学逐式核验/pinch 基准式/WebKit 守卫/focus trap）、FolderTree 三 effect、行级组件群（ActionMenu 三路关闭+焦点归还/ActionSheet+ShareDialog 编排/clipboard 双路/ThemeToggle 双观察器清理）——除 R-37/R-39/R-40 外全部核清。
- **FTS ↔ 冷热一致性全链**：归档 flipped 守卫 + content='' 同事务、回热 delete+insert 同事务、rename 同步 name、删除同事务 unindex、backfill 热态复核。
- **API 级并发六场景全部安全降级**（单进程同步推理逐窗口枚举）：upload-overwrite×tiering-archive（同 doc 锁串行 + 两侧翻转守卫）、deleteNode×在途渲染（fd 已开可读 / ENOENT→404）、share revoke×/s/（撤销前瞬渲染或 404）、beacon×delete（0 行无害）、moveNode×upload-overwrite（moveNode 全同步无 await 点 + 翻转守卫 + 壳层 retry，双窗口枚举收敛）、GC×lazyRegisterRefs（同步事务互斥 + content-hash/status 双守卫）。
- **测试盲区定向核查**：search LIKE 兜底/图片代理（codegraph「无覆盖」为误报，describe 实存）/upload warnings/shares 过期分支均有覆盖；moveNode 含 cold 行、overlay-history、ThemeToggle 持久化、beacon 同路由切换为 verified-untested-but-correct（代码 trace 正确）。
- **配置矩阵**：install.sh env 模板键集齐全（`ORIGIN=${BASE_URL}` 同值/BODY_SIZE_LIMIT 公式联动）；compose 卷/端口/优先级；svelte.config ↔ vitest.config ↔ SvelteKit alias 三处一致；vitest per-run 库隔离与备案一致。
- 备注级（不占编号，AGENTS backlog「CSP report-only 缺 frame-ancestors」近亲增量）：svelte.config `img-src` 仅 `'self'+data:`——s3 presign 外域直连图在 report-only 下持续上报；**未来转 enforcing 时除 frame-ancestors 外还须放行对象存储域名**，否则 s3 后端图片全裂。当前零用户可见影响。

---

### 3.7 Cycle-4 补充核清面（终轮收敛扫描）
- **markdown.ts 渲染管线角落**（除 R-02）：Shiki 单例失败重试复位正确；语言链 known→text→escape 三级兜底；`table_open/close` 包裹对空表/列表内表/blockquote 内表产出合法 HTML；RENDER_CACHE 硬上限 128 FIFO；跨 owner 复用安全（替换阶段产新串不回写缓存，names 三方消费者均只读，无缓存投毒）；占位符伪造不可达（需 sha256 前 8 hex 定点）；typographer/linkify 与占位符无交集路径。
- **images.ts 状态机第三遍**：init 循环各分支（ready+head 自愈/pending 复用/deleted 复活/UNIQUE 重试）在单线程同步模型下无名字分配竞态窗口；relay 字节真值顺序、flip 失败 recheck、confirm ETag undefined 语义、direct 通道孤儿反查顺序（先删行后反查）全部复核成立；serveImageResponse 存储 mime + nosniff。
- **storage.ts tmp 边缘**：tmp 随机短名并发不碰撞；写/改名任一失败均清 tmp；mkdir 失败无残留。
- **纯函数终检**：theme/time（未来日期「刚刚」钳制）/folder-tree（环自 null 根结构性不可达 + MAX_TREE_DEPTH 双保险）/row-menu（6/5/3 形态）全部干净。
- **自选 Top-3**：markdown-math 自定义渲染器**均过 `md.utils.escapeHtml`——`{@html}` 审计的「html:false 即安全」论证无旁路**；blobstore 注册表 + local 后端数据面（resolve 二次防穿越/put 原子写/getRange 封口/delete 幂等）干净；extractImageNames 去重保序使占位符索引对齐精确、`%`/空格名往返成立——`#`/`?` 名断裂即 R-41。

---

### 3.8 Cycle-5 缺陷族扫描（校验域 ↔ 消费域，十对逐一比对）

| # | 扫描对 | 结论 |
|---|---|---|
| A.1 | 标签名校验 ↔ FTS/LIKE ↔ chip ↔ `?tag=` | **分歧 → R-42**（逗号）；其余角度一致（`/` 拒收、参数化 IN、URLSearchParams 往返、UTF-16 长度两校验器同口径） |
| A.2 | 文档/文件夹名 parsePath ↔ 磁盘 ↔ FTS name ↔ 面包屑/URL ↔ `<title>` | **一致（safe）**——URL 恒用 id、name LIKE 有转义、`<title>` Svelte 文本转义 |
| A.3 | 图片名（除 R-41 `#`/`?`）↔ proxy URL ↔ `[name]` decode ↔ 精确匹配 | **分歧 → R-43**（`%XX`）；`+`/unicode/前导点/孤立 `%` 往返成立 |
| A.4 | email 归一化 ↔ 限流键 ↔ DB | **分歧（边缘）→ R-44**（seed-token 裸匹配）；主链一致且无第三写入方 |
| A.5 | token 字符集（share/api/invite base64url）↔ URL decode ↔ DB | **一致（safe）**——base64url 字符全为 URL 非保留字符，解码恒等 |
| A.6 | 游标 `before` ↔ row-value；`sort`/`view`/`limit` | **一致（safe）**——三白名单齐备、`^\d+$`+clamp、客户端 `encodeURIComponent` 往返 |
| A.7 | env 解析三域 | **一致（safe，无 R-29 外新角度）**——`envInt` 严格拒非数 fail-fast；BODY_SIZE_LIMIT 后缀域同语义 |
| A.8 | 桥 config ↔ api-client | **一致（safe）**——仅 baseUrl/token 两字段，baseUrl trim+尾斜杠归一 |
| A.9 | zod 工具 schema ↔ 服务端路由校验 | **一致（safe）**——zod 松侧类型约束、服务端完整收口、400 message 透传（413 丢 message=R-31 已录） |
| A.10 | Mermaid `data-rr-raw` 编解码往返 | **一致（safe）**——encodeURIComponent/decodeURIComponent 严格互逆 + 空串守卫 |

三条新发现（R-42/R-43/R-44）全部落位族内，无族外独立新缺陷；自选 B1（标签名全生命周期四表面）产出 R-42、B2（Mermaid 编解码对+渲染 id）干净。

---

## 4. 循环记录

| 轮次 | 日期 | 范围 | 新确认问题 |
|---|---|---|---|
| Cycle 1 | 2026-09-26 | 四维度全项目（5 路：服务端正确性 / 路由前端正确性 / 架构 / 功能实测 / UX+文档） | **23 条**（P1×1 / P2×6 / P3×16），全部经逐项独立复核确认 |
| Cycle 2 | 2026-09-26 | 盲区定向 + 对抗复核（3 路：DB/迁移/搜索/表单actions / 桥+shared+脚本 / cycle-1 通过面复检+Docker+交互面） | **13 条**（P1×1 / P2×1 / P3×11），全部经逐项独立复核确认；另否决候选 1 条（搜索页「归档误标」——模板实际含 `storageTier === 'cold'` 条件，候选证据失实） |
| Cycle 3 | 2026-09-26 | 收敛验证轮（2 路：组件内部逐行 / 测试盲点+剩余流程+并发+配置矩阵） | **4 条**（P1×1 / P2×1 / P3×2），全部经逐项独立复核确认；并发六场景/配置矩阵/测试盲区全部核清 |
| Cycle 4 | 2026-09-26 | 终轮收敛（1 路：渲染管线角落/images 三审/storage tmp/纯函数 + 自选 Top-3） | **1 条**（P3×1，R-41），逐项复核确认；math 渲染器 XSS 旁路排查为干净 |
| Cycle 5 | 2026-09-26 | 缺陷族扫描（1 路：校验域↔归一化域十对比对 + 末轮长尾） | **3 条**（P3×3，R-42/R-43/R-44），全部族内成员、逐项复核确认；十对扫描表 7 对 AGREE-safe |
| Cycle 6 | 2026-09-26 | 族内复核轮（1 路：7 个 AGREE 结论对抗复检 + 14 个新域对枚举） | **0 条——收敛达成**（7/7 HELD；新攻击点「null ownerViewedAt 游标」被 `isNotNull` 过滤证伪；Shiki 未知语言 throw / base64url 无 padding / cookie@0.7.2 maxAge 取整等实证阴性） |

发现数轨迹：**23 → 13 → 4 → 1 → 3（族内定向回升）→ 0**。收敛判据「某一整轮零新确认问题」于 Cycle 6 达成；cycle-5 的回升系「定向族扫描」的预期产物（族成员成批出土），非发散信号。

---

## 5. 终审结论

- **总量**：44 条确认发现——**P1×3**（R-01 PRODUCT.md 功能状态倒置 / R-24 搜索摘要误用 `highlight()` 返回全文 / R-37 Lightbox 加载状态机死锁）、**P2×8**（R-02 锚点数学标题 slug、R-03 匿名返回链接、R-04/05/38 文档与部署指引、R-06 编排重复、R-07 超长模块、R-25 图片改写表格漏改）、**P3×33**。零 P0；无安全漏洞级发现（XSS 旁路、注入面、越权面均为阴性）。
- **方法**：6 轮 × 16 个审查通道（oracle×8 / deep×2 / unspecified-high×5 / 功能实测×1），四维度全覆盖；每条发现均经 orchestrator 逐项独立复核（亲读代码/实测命令验证证据链），复核阶段否决失实候选 2 条（「搜索页归档误标」「—」）；实机验证含 756/756 测试、e2e 全链路、锚点 Playwright 真浏览器、多项 in-memory SQL/node 实证。
- **稳健性**：服务端核心不变量（上传自愈锁序、tiering 翻转守卫、图片三环字节绑定、GC 收敛、认证时序）历经 3-4 轮独立 trace 全部成立；并发六场景全部安全降级；cycle-1 通过面 10 项声明经对抗复检全部 HELD。
- **修复建议聚类**（供排期，非本报告义务）：R-41+R-43 用「归一化不动点」单点收口；R-42/R-44 各一行；R-37 拆 `resetView`/`switchTo`；R-24 换 `snippet()`；R-38 补 README/INSTALL 必改清单；文档批（R-01/03/04/05/16/17）一次回写。
- **约束遵守**：全程只审查不修改——仓库唯一变更即本报告文件（`git status` 其余 clean）；测试/服务器一律临时目录隔离。

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
