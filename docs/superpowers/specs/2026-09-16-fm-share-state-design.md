# FM 分享状态可视化与行操作收敛设计

- 日期：2026-09-16
- 状态：已定稿（待实现）
- 关联：`2026-07-18-remote-reader-design.md`（§3 架构 / §6.4 权限）、`2026-09-14-mobile-fm-design.md`（§7.1 ActionSheet / 抽屉编排）、`2026-09-08-recent-documents-view-design.md`（RecentDoc 契约）

## 1. 背景与目标

文件管理器（FM）当前无法从行上一眼看出文档是私有还是已共享，也无法在 FM 内直接拿到分享链接（只能去 `/settings/shares` 翻列表）或把文档转回私有。同时桌面行内操作按钮随功能增长即将变挤。

本次交付：

1. **行首图标双样式**：私有文件 / 共享文件两种 SVG 图标，共享状态一眼可辨
2. **行操作收敛**：桌面行内按钮簇（✏ 📂 🗑 🏷）收敛为 ⋯ 下拉菜单；移动端保留底部 ActionSheet；两端菜单项同构，新增「复制分享链接」「转为私有」
3. **点击空白关闭**：ActionSheet 与目录树抽屉补 backdrop 点击关闭
4. **页签位置统一**：三视图（目录内容/最近文档/最近浏览）页签恒右贴边，不再随视图漂移

## 2. 范围

**做**：上述 4 项；`RecentDoc`/`DocDTO` 契约扩展；`/api/share/[id]` 新端点；`ensureShareUrl` 过期过滤修正。

**不做**（明确出界）：

- `/settings/shares` 页不动（仍是全量链接管理 + 单条撤销入口）
- `/d/[id]` 查看页不动（不加分享管理）
- 搜索结果行不加图标
- 不做链接有效期设置 UI（`expiresAt` 仍无生产者，活跃过滤仅为正确性预留）
- 不引入 documents.shared 反规范化列

## 3. 数据与派生状态

### 3.1 活跃链接定义（单源）

`share_links` 行视为**活跃**当且仅当 `expires_at IS NULL OR expires_at > now`。当前所有链接 `expires_at` 均为 NULL（`createShareLink` 唯一生产者），过滤逻辑为正确性预留。

`apps/web/src/lib/server/shares.ts` 新增：

```ts
// 活跃判定单源：上传幂等分支与新 get-or-create 共用
function activeShareOf(documentId: string): { token: string } | null

// 批量派生：哪些文档存在活跃链接（owner join 为防御性过滤，入参本就 owner 作用域）
export function sharedDocIds(ownerId: string, docIds: string[]): Set<string>

// FM 复制分享链接：get-or-create；owner 不符/文档不存在/是文件夹 → null
export function getOrCreateShareUrl(ownerId: string, documentId: string): string | null

// 转为私有：删该文档全部活跃+过期链接（owner 过滤），返回删除条数；幂等（0 条也 ok）
export function revokeAllShares(ownerId: string, documentId: string): number
```

`documents.ts` 的 `ensureShareUrl`（上传幂等路径）改走 `activeShareOf`，消除「返回已过期链接」盲区。

### 3.2 DTO 契约扩展

`RecentDoc`（`lib/shared/recent.ts`）增加 `shared: boolean`；`DocDTO = Omit<RecentDoc, 'tags'>` 自动继承。folder 行恒 `false`。填充点（调用方展开，同 tags 拼装模式）：

- `+page.server.ts` load：dir 视图按 `children` 中 file ids、recent/viewed 视图按 rows 中 file ids 批查
- `/api/recent`：同上（loadMore/re-sync 追加的行也有）

## 4. API

`apps/web/src/routes/api/share/[id]/+server.ts`，认证与 404 口径镜像 `/api/view/[id]`（session 认证；不泄漏存在性）：

- `POST`：`locals.user` 缺失 → 401；`getOrCreateShareUrl` 返回 null（非 owner/不存在/folder）→ 404；成功 `200 { url }`（绝对 URL，`getBaseUrl()` 拼装）
- `DELETE`：同认证；`revokeAllShares`（幂等，0 条也 200）→ `200 { ok: true }`

CSRF 姿态与 `/api/view/[id]` POST beacon 一致：POST 为 simple request 可被跨站表单触发，但响应跨域不可读、建链接不产生泄露；DELETE 需 CORS 预检被同源策略拦截。不额外加 token。

## 5. UI 设计

### 5.1 FileStateIcon（新组件，`$components`）

- props：`type: 'file' | 'folder'`、`shared?: boolean`
- 三形态：文件夹 SVG / 私有文件 SVG（描边文档轮廓）/ 共享文件 SVG（同轮廓 + 右下角标圆底内含链接符号，角标用 `var(--rr-link)`）
- `currentColor` 描边，深浅主题自适应；**不写死色值**（theme.css 规矩）
- 外层 `span` 带 `aria-label`（已共享/私有；folder 无），SVG `aria-hidden`
- 替换 `+page.svelte`（dir 视图）与 `RecentList.svelte` 行内 📄/📁 emoji

### 5.2 RowActions 重构

- 单一 ⋯ 按钮双端可见（去掉 `mobile-only`）；`onMore` 回调统一入口
- 删除桌面行内 `inline-actions`（✏ 📂 🗑）与两处行内 🏷 标签按钮（标签编辑进菜单）
- moving 中：桌面在 ⋯ 位置显示「← 左树选目标」+ 取消（现状语义保留）；移动端不变（取消走抽屉内提示）

### 5.3 ActionMenu（新组件，桌面下拉）

- props 与 ActionSheet 同构：`actions: { key, label, danger? }[]` + `onSelect`；`show(anchor)` / `hide()` 经 `bind:this`
- **fixed 定位**锚定按钮 rect（右对齐、下弹；视口下缘溢出则上翻）——`.fm-right` 是 `overflow-y: auto` 滚动容器，`position: absolute` 会被裁剪
- 外点关闭（document click capture）+ Esc 关闭（焦点归还 ⋯ 按钮）；打开时 focus 第一项
- 滚动时关闭（监听 scroll capture，菜单跟随复杂度不值）
- 不推 history 条目（桌面无 Android 返回键场景）

### 5.4 ActionSheet 增补

- backdrop 点击关闭：dialog `click` 事件 `e.target === dialog` 判定 → `hide()`（走既有 `onclose` → 解滚动锁 + consume 编排，返回键语义不变）
- 菜单项见 5.6

### 5.5 ShareDialog（新组件）

- 居中 `<dialog>`（`margin: auto`，`max-width: min(92vw, 34rem)`）
- 内容：标题「分享链接」+ 说明（免登录可查看，发给需要的人）+ **只读 input**（value = url，点击全选）+ 复制按钮 + 关闭
- 复制：`navigator.clipboard.writeText` → 按钮文案「已复制 ✓」2s 复原；失败（非安全上下文/权限拒绝）降级 `input.select() + execCommand('copy')`；仍失败保留可手动选中复制（input 恒可交互）
- Esc / backdrop / Android 返回键关闭；`lockBodyScroll` + `overlay-history` 同 ActionSheet 编排
- `+page.svelte` 与 `RecentList.svelte` 各持一个实例（无状态小组件，不做全局单例）

### 5.6 菜单项（两端同构）

| 行类型 | 菜单项 |
|---|---|
| file | 重命名 / 编辑标签 / 移动到… / **复制分享链接** / **转为私有**（仅 `shared` 时展示，danger）/ 删除（danger） |
| folder | 重命名 / 移动到… / 删除（danger） |

- `sheetItem`/菜单上下文状态扩为 `{ id, type, shared }`
- 「复制分享链接」永远可用（get-or-create：私有时点它 = 新建链接，图标随后翻转为共享）
- 「转为私有」带 confirm：「转为私有后，该文档的所有分享链接立即失效（已发出的链接无法再打开），且不可恢复。继续？」——与删除的 confirm 风格一致

### 5.7 点击空白关闭抽屉（+page.svelte）

drawer dialog `click` 事件 `e.target === drawerRef` → `closeDrawer()`（既有路径：解锁 + 焦点归还汉堡 + consume）。抽屉宽 `min(80vw, 20rem)`，右侧留白即热区。

### 5.8 页签位置统一（+page.svelte）

根因：`.fm-head` 是 `space-between`，目录视图多出的新建文件夹表单是第三个 flex 子元素把 segmented 挤到中间；recent/viewed 无此表单 → segmented 贴右。

修复：DOM 重排为「左标题 | 右簇 [新建表单(desktop) / ＋📁(mobile)] [segmented 恒末位]」——三视图 segmented 恒右贴边。`space-between` 保留（左簇 crumbs 自然伸展）。

## 6. 状态刷新与错误处理

- **复制分享链接**成功（可能新建了链接）→ `invalidateAll()` + `recentRef?.reSync()`（图标私有→共享翻转），ShareDialog 不受 invalidate 影响（不卸载）
- **转为私有**成功（200/404 均视为完成，404 = 文档已不在）→ 同上刷新（图标共享→私有）
- 失败反馈走既有通道：dir 视图 `actionError`、RecentList `deleteError` 横幅风格；fetch 非 2xx 读 body `{message}`（api-client 同语义，此处端点直接返回 SvelteKit `error()` JSON 形状）
- shared 状态短暂陈旧（他端撤销/新建，本端未刷新）→ 图标到下次刷新才翻转；菜单动作服务端是权威（get-or-create / 删全量），无误操作风险

## 7. 安全考量

- 端点 session 认证 + owner 校验 + 404 不泄漏存在性（库内既有口径）
- 「转为私有」= `DELETE FROM share_links WHERE document_id = ? AND owner join`，全量删除，无残留
- 并发（转为私有 vs 上传 ensureShareUrl）：均为单条 SQLite 语句原子操作；窗口内竞态最多产生一条新活跃链接，用户再点一次「转为私有」即收敛，无需加锁
- token 生成沿用 `generateShareToken()`（16B randomBytes base64url）

## 8. 测试策略

- **单测**（vitest，node）：
  - `shares.test.ts` 扩展：`getOrCreateShareUrl`（新建/复用/过期→新建/owner 不符→null/folder→null）、`revokeAllShares`（owner 过滤/多条全删/幂等）、`sharedDocIds`（批量/过期过滤/folder 不在）
  - `documents.test.ts`：`ensureShareUrl` 过期过滤回归
  - API 端点测试（镜像 view-beacon 风格）：POST/DELETE 的 401/404/200 形状、owner 隔离
  - DTO 契约：load 与 `/api/recent` 载荷含 `shared`
- **Playwright 冒烟**（并入既有 13 项套件）：双端菜单项齐全、图标双样式、复制分享链接弹层与复制反馈、转为私有后图标翻转、backdrop 关闭（sheet + 抽屉）、三视图页签位置一致
- **回归**：全量 vitest + `svelte-check` 0 错 + `build` 冒烟

## 9. 验收清单

- [ ] 私有/共享文件图标肉眼可辨，深浅主题均正常
- [ ] 桌面 ⋯ 下拉与移动 ActionSheet 菜单项一致且齐全
- [ ] 复制分享链接：拿到 `/s/<token>` 绝对 URL，可复制，私有文档点它即变共享
- [ ] 转为私有：链接全部失效（`/s/<token>` 打不开），图标翻回私有
- [ ] ActionSheet 与目录树抽屉点击空白即关
- [ ] 三视图页签位置一致（恒右贴边）
- [ ] 全量测试 + svelte-check + build 通过
