# 图片支持设计（资产池去重 · 桥直传云 · CDN 直连取图 · Lightbox）

> 日期：2026-09-20 · 状态：设计定稿 v4（细节讨论完毕；存储结构经 Oracle 对抗审查修复，全文经第二轮 Oracle 代码对照审查修复 P0-1 + P1×4 + P2×7）

## 1. 背景与目标

当前 Remote Reader 对**纯文本 Markdown** 渲染友好。用户需求：支持**内嵌图片的 markdown 文件**，前端提供放大/全屏/缩放/拖动查看局部体验。

图片三种来源（均支持）：**Agent 本地图片资产**（主场景，当前缺失）、外链 http/https（现状已渲染，本次补交互）、base64 内嵌（现状已渲染，补交互）。

部署背景：开源项目供他人自部署；生产机带宽有限（frp 内网穿透）——**图片字节全链路（上传+阅读）不流经应用服务器**；已用七牛云（S3 兼容）做冷热分层。

### 目标

- Agent 上传带图 md **零新增概念**：仍只调 `upload_document`，桥自动编排（解析→预检→上传→改写）
- **去重**：owner 内按内容 hash 只存一份，重复上传零流量（init 预查）
- **存根 + 自动 GC**：init 即建存根行，两段 deadline（pending 1h / ready 无引用 24h），引用归零即清
- **存储后端插件式**：BlobStore 无状态接口 + local/s3 内置 + 行级 backend 溯源（换后端不炸旧图）
- **上传直传云**（presigned PUT）+ **阅读 CDN 直连**（presigned GET）——服务器只过元数据
- 前端 **Lightbox**：放大/全屏/滚轮锚定缩放/pinch/拖动/双击

## 2. 端到端流程

```mermaid
sequenceDiagram
    participant Ag as Agent
    participant Br as MCP 桥（本地）
    participant Sv as Web 服务器
    participant OSS as 云存储（七牛/R2/MinIO）

    Note over Ag,Br: Agent 只管写 md，引用本地路径
    Ag->>Br: upload_document({name, content})

    Note over Br: ① token 级解析提取本地引用<br/>② 预检阶段：全部图 stat+magic 一次性体检<br/>（任何问题 → 完整错误清单，零字节上传）
    Br->>Br: 逐图 sha256 + md5

    loop 每张新图（预检全过后）
        Br->>Sv: POST /api/v1/images/init {name, hash, md5, size}
        Note over Sv: 存根：插 pending 行（或复用/复活）
        alt owner 内 hash 已有 ready 行
            Sv-->>Br: {status:"exists", name:注册名}（零流量）
        else s3 后端 → 直传
            Sv-->>Br: {status:"direct", name, upload_url, image_id}
            Br->>OSS: PUT 图片字节直传（不过服务器）
            Br->>Sv: POST /api/v1/images/confirm {image_id}
            Note over Sv: 三重验证：HEAD(size)+range(magic)+ETag==md5
            Sv-->>Br: ok / missing / invalid
        else local 后端 → 中转
            Sv-->>Br: {status:"relay", name, image_id}
            Br->>Sv: POST /api/v1/images {image_id, content_base64}
            Note over Sv: 验证 + UPDATE pending→ready
            Sv-->>Br: {name}
        end
    end
    Note over Br: ③ 改写 md：本地路径 → 稳定名
    Br->>Sv: POST /api/v1/documents（改写后的 md）
    Sv->>Sv: 落盘 + refs 声明式登记
    Sv-->>Br: {id, url}
    Br-->>Ag: 已上传 + url + 图片摘要

    Note over Sv,OSS: —— 读者打开 /s/<token> ——
    Sv->>Sv: SSR：渲染（缓存存占位符）→ 替换（每请求执行，签名桶对齐）
    Sv-->>OSS: HTML：s3 图=签名 URL·CDN 直连；local 图=代理路由
    OSS->>OSS: 浏览器直连取图
```

## 3. 已确认的设计决策

| # | 决策点 | 结论 |
|---|---|---|
| 1 | 图片模型 | owner 级资产池（脱离 documents 目录树；FM 不显示图片行） |
| 2 | 稳定名 | **服务器分配**（init 响应的 name 是唯一权威，桥不得用请求名改写 md）；同名不同内容自动后缀 `shot-2.png`；ready 过的名字永不复用（墓碑 UNIQUE 占位）；pending 超时释放名字（从未被引用，安全）；名字空格 sanitize 为 `-` |
| 3 | MCP 工具面 | `upload_document` 单工具不变；不新增独立 upload_image MCP 工具（备案） |
| 4 | 去重+预查 | 融合进 init：报 `{name, hash, md5, size}` → exists 复用（零流量）/ pending 共享 / 墓碑复活 / 新建 |
| 5 | 上传通道 s3 | 桥直传云：presigned PUT（TTL=插件 `uploadUrlTtlSeconds`，默认 600s，单 key 最小权限，桥全程不持有云凭证）→ confirm 登记前验证 |
| 5b | 上传通道 local | 服务器中转（base64 ×1.37）：**local 模式 init 同样插 pending 行**，relay = UPDATE pending→ready + 写盘（非独立入口，无独立查重） |
| 5c | 双哈希 | sha256=去重键（行级）；md5=confirm 诚实性校验（S3 单段 PUT ETag=MD5；七牛口径实测，不标准则退化 magic+size） |
| 6 | 格式白名单 | png/jpeg/gif/webp；magic bytes + 扩展名双校验；SVG 拒绝（XSS） |
| 7 | 单图上限 | `MAX_IMAGE_BYTES` 默认 10MB；BODY_SIZE_LIMIT 启动校验联动 ×1.37×1.5（relay 通道） |
| 8 | 免登录鉴权 | 代理路由 refs 白名单（token→md→图，且该 md 的 refs 命中）；share token 不能枚举 owner 未引用图 |
| 9 | s3 取图 | 签名 URL 直连 CDN（TTL=`IMAGE_SIGNED_URL_TTL` 默认 1h）；按行内 backend 签名（溯源） |
| 10 | 隐蔽开关 | `IMAGE_PROXY_ALL=1` 强制全代理（默认 0=直连） |
| 11 | 引用登记 | 声明式（md 上传/覆盖 diff 重算）+ 渲染时**替换阶段**惰性补录（`INSERT OR IGNORE`，仅 ready 行；缓存命中路径也执行） |
| 12 | GC | 全自动（refs 归零软删除墓碑 + 删 blob）；无手动删除 UI（备案） |
| 13 | 孤儿回收 | 周期任务（tiering tick 复用，分批 LIMIT）：pending 超 1h 物理删（释放名字）；ready 无 refs 超 24h 软删 |
| 14 | fail-fast 两阶段 | 预检阶段一次性报告全部问题（零字节上传）；上传阶段中断带进度摘要 |
| 15 | RENDER_CACHE | 占位符两段式：`%%RR:IMG:<contentHash 前 8>:<n>%%`（自指不可能构造，天然防冲突）；缓存 value 从 string 变 `{html, names[]}`；替换每请求执行 |
| 16 | referrer | 页面全局 no-referrer 不变（token 不外发）；仅签名 URL 图加 img 级 `strict-origin-when-cross-origin`（发 origin 供七牛 Referer 白名单） |
| 17 | 存储后端 | BlobStore 无状态接口 + 注册表路由 + 行级溯源；**不做运行时动态插件**（代码级扩展） |
| 18 | 冷却通用化 | tiering 注入 BlobStore（行为不变）+ documents 冷档行补 backend 溯源列；不重构 tiering |
| 19 | 图片与分层 | 图片不参与冷热分层（无 tier 列）；有 refs 的 local 图常驻本地盘（备案接受） |
| 20 | 引用语法 | md 内裸名（去 `./`、query、fragment，URL decode 后全名匹配 owner 池）；外链/data: 原样；含路径分隔符不匹配 |
| 21 | 存根模型 | init 即插行（status=pending）；行 id 即 confirm 持久令牌（抗服务器重启）；两段 deadline 见 §4 |
| 22 | 软删除墓碑 | ready 图 GC 不物理删行，置 `deleted` 留墓碑（UNIQUE 占位实现名字永不复用，无应用层竞态）；同内容重传时复活（全字段重置） |
| 23 | 插件元数据 | 插件自声明 `id`（公共契约，有数据即冻结）；核心启动建注册表 `Map<id, store>`；`uploadUrlTtlSeconds?` 可选（默认 600）；presign `opts?` 不透明透传缝（未来七牛 imageView2 等） |
| 24 | 插件能力分级 | L0 = put/get/delete/head（+getRange）→ 全功能可用（上传走 relay、取图走代理，吃服务器带宽）；L1 = +presign → 直传+直连。**presign 永远是加速项不是依赖，代理路由是万能兜底** |
| 25 | 图片定位原则 | **图片是文档的内嵌内容，不是一等公民资产**——精细管理（去重/存根/GC）动机是控制存储成本，不提供图片管理能力；一切可见性/操作需求除非来自真实场景不进 v1（列表 API 备案） |
| 26 | 取图缓存 | 代理路由 `no-cache` + `ETag="<content_hash>"`（协商复用，撤销即时性与 no-store 等价）；直连路径**签名时间桶对齐**（TTL/6 一桶，桶内 URL 稳定 → 浏览器缓存命中）；代理路由 v1 不支持 Range（img 全量加载 + Safari bytes=0-1 探测对 200 兼容）；直连图客户端 `onerror` 兜底占位（带原因，§7.5） |
| 27 | 插件接口定形 | 能力域窄定制（只认 key+字节，元数据在 DB 行 → 图片/冷档共用）+ 消费者横向复用 + 极简硬编码 Map 注册（不做 manifest/运行时加载/版本协商）；**演进纪律：只能加可选成员，禁止加必选/删改签名**，能力用运行时探测（§8） |
| 28 | 单文档引用数上限 | `MAX_IMAGE_REFS`（shared 常量，=500）：refs 登记时拦截（413 语义）——防超大文档拖垮 R1 集合差重算与补录事务；上限值调优等真实痛点再说（交叉审查修复批） |

## 4. 数据模型（完备版，经 Oracle 审查修复）

### 4.1 DDL

```sql
CREATE TABLE images (
  id              TEXT PRIMARY KEY,              -- generateId()，兼 confirm 持久令牌
  owner_id        TEXT NOT NULL REFERENCES users(id),
  name            TEXT NOT NULL,                 -- 服务器分配的稳定引用名，owner 内唯一
  content_hash    TEXT NOT NULL,                 -- sha256 hex，去重键
  content_md5     TEXT NOT NULL,                 -- md5 hex，confirm 诚实性校验
  mime_type       TEXT NOT NULL,                 -- magic 判定，恒白名单四值
  size_bytes      INTEGER NOT NULL,              -- pending=init 报称；ready 后=实测回写
  status          TEXT NOT NULL DEFAULT 'pending',  -- 'pending' | 'ready' | 'deleted'
  storage_backend TEXT NOT NULL,                 -- 写入时锁定的插件 id（溯源）
  storage_key     TEXT NOT NULL,                 -- 插件自解释：local '<ownerId>/blobs/<h2>/<hash>' / s3 'images/<ownerId>/<hash>'（per-owner 内容寻址，与 §8 DATA_DIR 布局一致）
  created_at      INTEGER NOT NULL,              -- pending deadline 计时起点（复活时重置）
  ready_at        INTEGER,                       -- confirm/relay 时刻（关联 deadline 起点；墓碑保留）
  UNIQUE(owner_id, content_hash),
  UNIQUE(owner_id, name)
);
CREATE INDEX images_status_created ON images(status, created_at);  -- pending 回收扫描
CREATE INDEX images_status_ready   ON images(status, ready_at);    -- ready 回收扫描

CREATE TABLE image_refs (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  image_id    TEXT NOT NULL REFERENCES images(id),
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (document_id, image_id)
);
CREATE INDEX image_refs_image ON image_refs(image_id);  -- GC 反查 / 白名单 EXISTS

ALTER TABLE documents ADD COLUMN storage_backend TEXT;  -- NULL=hot；非空=cold 行实际归档后端
-- 回填：UPDATE documents SET storage_backend='s3' WHERE storage_tier='cold'
```

- **storage_key 为 per-owner 内容寻址**（`<owner>/<hash>`）——同 owner 同 hash 必同一行（UNIQUE 保证），无跨行/跨 owner blob 共享，删除无连带风险
- **documents 双列纪律（实现现状勘误，交叉审查 B P2-3）**：`storage_tier` 与 `storage_backend` 由归档/回热路径**单点写入**（归档写 backend、回热清 NULL）。v1 读冷档实际走**全局单例** `getObjectStore()`（不按行路由）——`storage_backend` 列为**写入溯源备案**（换后端时定位旧对象的依据），按行路由待第二个后端真实启用时再上；双列单点写入一致性由测试锁定（防双真相源漂移）
- 迁移：Drizzle migration + `ensureSchema` 兜底（`ensureImagesTables()` / `ensureDocumentsStorageBackendColumn()`）；schema↔ensureSchema 等价性守卫测试同步

### 4.2 状态机

```mermaid
stateDiagram-v2
    [*] --> pending : init 插行（所有后端统一）/ 墓碑复活
    pending --> ready : confirm 验证通过 / relay 写盘验证通过
    pending --> [*] : 回收：超 1h 未 confirm → 物理删行+删对象+释放名字*
    pending --> [*] : 永久性 invalid：内容真值绑定后 magic/ext 失败<br/>（relay：sha256 过后；confirm：ETag==md5 过后）→ 删行释放 (owner,hash) 与名字
    ready --> referenced : md 上传 refs 登记
    referenced --> referenced : 覆盖上传 refs diff 重算
    referenced --> tomb : refs 归零（即时 GC）或 ready 无引用超 24h（周期兜底）<br/>软删除 + 删 blob + 留墓碑
    tomb --> pending : 同内容重传复活（全字段重置）
```

\* pending 释放名字安全：从未 ready、从未被引用，无顶替歧义（窄例外见 §9.1 续期机制）。
注：`referenced` 为**派生态**（refs 非空的 ready），非存储 status——DDL 的 status 只有 pending/ready/deleted。

### 4.3 GC 安全包（Oracle 审查修复，全部为不变量）

1. **条件式写路径**：一切回收/GC 的 UPDATE/DELETE 必须带 status 条件（乐观锁）：`DELETE … WHERE id=? AND status='pending'`、`UPDATE … SET status='deleted' WHERE id=? AND status='ready'`——0 行即跳过后续动作
2. **删 blob 前反查 key 活行**：物理删 blob 前在同一 tick 内 `SELECT … WHERE storage_key=? AND status IN ('pending','ready')`，有活行则跳过删除（下轮再看）——封死"行删后重传同 key 新行 → 延迟的 blob DELETE 误删活图"数据丢失链
3. **refs 补录事务边界**：同步事务内 `SELECT status='ready'` 校验 + INSERT（better-sqlite3 同步无 await，与其他事务天然串行）
4. **GC 软删事务边界**：事务内复查 `refs==0` 后条件式 UPDATE；blob 删除在事务提交后（失败仅日志，孤儿由下轮/墓碑清理兜底）
5. **confirm 0 行回查分流**：UPDATE pending→ready 0 行后回查行状态——ready → 幂等 ok；deleted/无行 → missing（桥重走 init，防 GC 后谎报成功）

### 4.4 关键并发语义（UNIQUE 兜底）

| 场景 | 行为 |
|---|---|
| 同 owner 同内容并发 init | 撞 `UNIQUE(owner,hash)` → 后到者共享同一 pending 行的 presign（key 同内容寻址，谁的 PUT 先到都一样），任一 confirm 即转正；**响应返回行内注册名**（可能异于请求名） |
| 同名不同内容并发 init | 撞 `UNIQUE(owner,name)` → 后缀循环重试；**每轮重试前重查 hash 分支**（防撞 hash UNIQUE 死循环）；后缀上限 16 |
| 名字超长 | 基名+后缀超 parsePath 单段限制 → 截断基名再试（上限内保证可分配） |
| 并发复活同一墓碑 | 复活 UPDATE 带 `WHERE status='deleted'`，0 行者重查走 pending 分支 |
| confirm 与回收竞态 | 回收删行后 confirm → missing → 桥重走 init（重新分配，损失极小） |

### 4.5 查询路径 × 索引

| 流程 | 查询形状 | 命中 |
|---|---|---|
| init 去重 | `owner=? AND content_hash=?` 按 status 分支 | UNIQUE 索引 |
| 名字后缀分配 | 候选名**逐个精确 `=` 探测**（2..16）——`%`/`_` 为合法文件名字符，LIKE 前缀扫描会过匹配导致跳号/提前耗尽上限；如保留 LIKE 优化必须 ESCAPE 转义 | UNIQUE(name) |
| 渲染替换按名查行 | `owner=? AND name=? AND status='ready'` | UNIQUE(name) |
| refs 白名单 | `EXISTS(… document_id=? AND image_id=?)` | PK 左前缀 |
| refs 归零判定 | `NOT EXISTS(… image_id=?)` | image_refs_image |
| pending 回收 | `status='pending' AND created_at<now-1h` | images_status_created |
| ready 回收 | `status='ready' AND ready_at<now-24h` | images_status_ready |

## 5. Web API

错误形状 SvelteKit `error(status, message)` → `{"message":"..."}`。

### 5.1 `POST /api/v1/images/init`

- 认证 Bearer token + authfail IP 桶；限流轻桶 `images-meta:${tokenId}`（默认 120/min）
- Body `{name, content_hash, content_md5, size_bytes}`；校验链（**P0-1，顺序不可变**）：**`content_hash` 须匹配 `/^[0-9a-f]{64}$/`、`content_md5` 须匹配 `/^[0-9a-f]{32}$/`，否则 400——hash 未经格式校验直接拼入 local 写盘路径（`blobs/<h2>/<hash>`），`..` 可穿越 DATA_DIR 任意写**；name 单段合法；size≤上限（413 预检）
- 逻辑（按序）：查 `(owner,hash)`——ready → `{status:"exists", name}`；pending → `{status:"direct"|relay 视后端, name, imageId, uploadUrl?}`（共享行，响应字段 **camelCase**——`image_id`/`upload_url` 为设计期笔误勘误）；deleted 墓碑 → 复活（全字段重置：status→pending、created_at=now、ready_at=NULL、backend=当前、key 新生成、md5/size 按新报值）→ 同新行响应；无行 → 插 pending → 同上
- **exists 分支 head 自愈（交叉审查修复批 P1）**：ready 行命中 exists 前先 `store.head(storageKey)` 探测——blob 丢失（磁盘损坏/误删）时降级墓碑（复用 GC 软删语义）走复活重传，封死"重传永远命中 exists → 裂图永续"；head 自身不可达（503 语义）不阻断幂等快路径
- 后端为 s3 → `direct` + presigned PUT（key=`images/<owner>/<hash>`，TTL=`store.uploadUrlTtlSeconds ?? 600`）；后端为 local → `relay`
- 名字冲突（不同内容）→ 后缀循环（§4.4）
- **单文档引用数上限（交叉审查修复批 #28）**：refs 登记（上传/覆盖）时校验 `extractImageNames(content).length > MAX_IMAGE_REFS`（=500，shared 常量）→ 413 语义拒绝（`TooManyImageRefsError`），防超大文档拖垮 R1 集合差重算与补录事务

### 5.2 `POST /api/v1/images`（relay）

- 认证/限流：与 documents 同规格的独立重桶；Body `{image_id, content_base64}`
- **行必须在 owner 作用域**（同 §5.3 confirm 口径，P2-1）
- 验证：base64 → 大小（实测字节，非 init 报称）→ **`sha256(buffer) == 行内 content_hash`（P1-1：封死去重池投毒——谎报 hash 的 init + 异字节的 relay 会污染 owner 全池 exists 复用）** → magic → 扩展名一致（同白名单口径）。**顺序即语义：sha256 真值绑定必须先于 magic/ext——其后 magic/ext 失败才可判永久性并删行（§4.2 永久性 invalid 出边）**
- 通过 → 写盘（local 布局；storage.ts tmp 名含随机后缀，并发写同目标为原子 last-wins，内容相同无害）+ 事务内 `UPDATE … SET status='ready', ready_at=now, size_bytes=实测 WHERE id=? AND owner_id=? AND status='pending'`（0 行回查分流同 §4.3-5）→ `{name}`

### 5.3 `POST /api/v1/images/confirm`

- 认证/限流同 init；Body `{image_id}`
- 验证（行必须在 owner 作用域且 status='pending'）：HEAD size≤上限；GET range 32B magic+扩展名；ETag==行内 content_md5（**默认强校验：mismatch 一律 invalid**；"非-MD5 后端"的退化开关仅在上线实测确认后以代码级常量开启，P2-5——防"一律退化"架空诚实性校验）
- 通过 → 条件式 UPDATE pending→ready + size 回写 → `{status:"ok", name}`；对象缺失 → `{status:"missing"}`；校验失败 → `400 {status:"invalid", reason}`，处置按分支：**ETag 不符** → 删云对象、行保留 pending（真值未证，行可能是无辜的，1h reaper 兜底）；**magic/ext 失败且 ETag==md5**（真值已绑定，错配永久）→ 删 pending 行释放 (owner,hash) 与名字（§4.2 永久性 invalid 出边）+ 反查式异步删孤儿对象（direct 通道对象已 PUT、删行后无其他回收路径；反查挡住改名重传同 key 新行的误删）；ETag 缺失或不符时的 magic/ext 失败 → 不删行不删对象（真值未证，行可能是无辜的）
- 0 行 → 回查：ready→ok；否则 missing

### 5.4 `GET /s/[token]/i/[name]` 与 5.5 `GET /d/[id]/i/[name]`（代理路由）

- /s/：share token → md 行 → refs 白名单（该 md 必须引用此图）→ 按行 backend+key 取字节 → `200 Content-Type=行内 mime + nosniff + Cache-Control:no-cache + ETag="<content_hash>"`（决策 #26：协商复用——未变 304 无 body，撤销/删除协商即 404，即时性与 no-store 等价；v1 不支持 Range）
- /d/：`session.user===md.ownerId`，其余同
- 失败统一 404；行内后端无实现 → 503

## 6. MCP 桥编排（两阶段）

### 6.1 阶段一：解析 + 预检（零字节上传）

1. markdown-it（进 shared）token 级解析取 image token（行内式+引用式；code/fence 天然不误伤）
2. 无 scheme 的 src 视为本地路径；相对路径按桥 cwd（错误信息暴露基准目录供 Agent 自愈）
3. 逐图 stat + 轻量魔数预判，**一次性报告全部问题**，六类错误码：`FILE_NOT_FOUND`（含绝对路径+cwd 基准）/ `PERMISSION_DENIED` / `IS_DIRECTORY` / `TOO_LARGE`（实际值 vs 上限）/ `UNSUPPORTED_FORMAT`（SVG 单独说明）/ `READ_ERROR`，每类带自愈建议
4. 错误输出为机器可解析多行结构（MCP isError content）

### 6.2 阶段二：上传

逐图 sha256+md5 → init → exists 复用 / direct PUT（桥 fetch 超时 300s）+confirm（missing 重 PUT、invalid fail-fast 报 reason）/ relay base64（超时 300s）。中断带进度摘要（"已上传 3 张重试自动跳过，失败于第 4/8 张"）。**429 退避（P2-3）：读 Retry-After（无则固定 30s）等待后重试当前图，不整体失败**；工具描述建议单文档 ≤50 图（轻桶 120/min 下 100 图两桶全爆）。

### 6.3 改写与收尾

token 级行内改写（image token 的 `.map` 行内替换 src 编码形态为**服务器返回的注册名**；请求名不作数）。同文档同内容多图天然去重（init 命中同名）。上传 md → 返回 `已上传（id=…）查看链接：… 图片：新传 N · 复用 M · 改写 K 处`。

## 7. 渲染与取图

### 7.1 两函数分离的管线接口（P3 修正：渲染阶段与替换阶段参数不得混合）

```ts
renderMarkdown(src: string): Promise<{ html: string; names: string[] }>   // 渲染阶段：仅依赖内容（缓存键 = 内容 hash）
resolveImages(html: string, names: string[], ctx: ResolveCtx): Promise<string>  // 替换阶段：每请求执行
// ResolveCtx = { kind: 'share', token, ownerId, docId, contentHash } | { kind: 'owner', docId, ownerId, contentHash }
```

**引用提取单源不变量（P1-3）**：裸名提取/归一化（scheme 过滤、URL decode、去 `./`/query/fragment、含分隔符不匹配）为 `packages/shared` 的**单一纯函数**，桥预检、Web 上传时声明式登记、Web 渲染 names[] 收集**三消费方强制共用**——任何一处私有实现都会造成 refs 漂移 → 活图被 24h GC（数据不可逆丢失）。已知语义差须测试锁定：Web 渲染实例带 math_inline/block 规则（`$![x](y)$` 被 math 吞），桥/shared 提取实例必须同配置。

### 7.2 两段式管线

```
渲染阶段（进 RENDER_CACHE）：md → { html（src=占位符）, names[] }
  占位符：%%RR:IMG:<contentHash 前 8>:<n>%%（自指不可能——伪造者须预知全文 sha256；
  <n> 替换时 bounds-check，越界忽略）
替换阶段（每请求执行，缓存命中也走到）：
  按 names[] 查行（只认 ready）→
    活行 → 生成 URL（§7.3 决策树，**name 一律 encodeURIComponent 后拼 URL**——
      `#` `%` `&` 均为合法文件名字符，`#` 不编码会被 fragment 截断、`%` 有解码歧义、
      `&` 进 src 属性不转义；裂图占位内 name 过 escapeHtml）+ refs 惰性补录
    无行/pending/后端缺失 → 替换为裂图占位 span
```

- **补录 content-hash 守卫（P1-4）**：惰性补录事务内校验 `documents.content_hash == 本次渲染所用 hash`，不等则跳过——封死"渲染期间发生覆盖上传 → 旧渲染把 R1 刚移除的引用补录回去 → 僵尸 ref 拖住已无引用的图永不收敛（24h 兜底也救不回）"竞态
- 补录批量单事务（50 图一个事务，而非 50 个）
- 缓存命中也每请求查行 = **特性**：图被 GC 后缓存 HTML 里的占位符替换时自然变裂图，缓存不会让已删图僵尸存活
- 50 图页面替换阶段毫秒级（SQLite 索引查询 + 本地 HMAC presign）

### 7.3 URL 决策树

`IMAGE_PROXY_ALL=1` → 全代理；backend=local → 代理路由；backend=s3 且实现存在 → presign GET（**签名时间桶对齐**：TTL/6 一桶，桶内所有 SSR 产出同一 URL → 浏览器缓存命中；有效期在 TTL~TTL+桶宽间波动）+ `referrerpolicy="strict-origin-when-cross-origin"`；backend=s3 但无实现 → 裂图占位（503 语义 title）。

### 7.4 裂图占位

`<span class="rr-img-missing" title="<原因>">🖼 [alt 或 name]</span>`，虚线框样式，不参与 lightbox。

### 7.5 直连图客户端兜底（onerror）

直连 CDN 图的加载失败（签名过期后直开/CDN 故障）发生在浏览器运行时，服务器侧占位管不到——`MarkdownViewer` 对正文 `<img>` 事件委托 `onerror`：替换为统一 `rr-img-missing` 占位（**带原因 title**，如"图片加载失败：CDN 不可达或链接已过期，刷新页面重试"），与服务器侧占位同款观感，避免浏览器原生裂图在深色模式下的糟糕样式。

## 8. BlobStore 与插件体系

```ts
interface BlobStore {
  id: string;                                  // 公共契约：有数据写入即冻结
  uploadUrlTtlSeconds?: number;                // 默认 600；慢后端自声明更长
  put(key, data: Buffer, contentType?: string): Promise<void>;
  get(key): Promise<Buffer>;
  head?(key): Promise<{ size: number; etag?: string }>;
  getRange?(key, start, end): Promise<Buffer>;
  delete(key): Promise<void>;
  presign?(op: 'get' | 'put', key, ttlSeconds, opts?: Record<string, string>): Promise<string>;
}
```

- 内置：`local`（`DATA_DIR/<owner>/blobs/<hash前2>/<hash>`）、`s3`（现 object-store-s3 泛化 + Buffer 化 + `@aws-sdk/s3-request-presigner`，官方七牛示例同款）
- 注册表：启动按 env 实例化，`Map<id, store>`；行内 backend 路由，查无实现 → 503
- **接口定形（#27）**：能力域窄定制——接口只认 key 与字节（mime/size/hash 元数据全在 DB 行，存储层不理解内容，因此图片与冷档文档共用同一接口）；消费者横向复用（图片/冷档/未来任何字节存储需求）；注册用极简硬编码 Map（第三方加插件 = PR 加实现类 + 注册一行，**不做** manifest/发现机制/运行时加载/版本协商——单实例自部署 PR 是自然贡献路径，npm 分发备案）
- **演进纪律**：只能加可选成员（`?`），**禁止加必选成员、禁止删改既有签名**（仓库外 fork 实现会静默断裂）；可选能力用运行时探测（`if (store.presign)`）——L0/L1 分级的实现方式，核心不得假设能力存在
- 能力分级：L0（put/get/delete/head[+getRange]）全功能——上传 relay、取图代理；L1（+presign）直传直连。**代理路由是万能兜底，presign 永远是加速项**
- 插件独有功能：存储侧行为（生命周期/防盗链/快照）厂商侧自配核心无感；业务感知功能（imageView2 等）v1 不做，`opts` 不透明透传缝预留
- NAS 接入：挂载（复用 local，零代码）/ WebDAV（新插件 ~100 行）/ S3 网关（复用 s3）
- 冷却通用化：tiering 注入 BlobStore；documents 冷档行记录 backend；读冷档按行路由（v1 实现为全局单例读、列作溯源备案——见 §4.1 双列纪律勘误）
- 数据结构不为未来预留 `backend_meta` 列（YAGNI；SQLite 加列廉价，等真实消费者）

## 9. 引用关系管理与 GC

### 9.1 引用计数：不存计数，派生计数

`images` 表**没有 ref_count 列**（故意）：引用关系以 `image_refs` 行存在，计数永远是 `COUNT(*)` 实时派生（有索引）——存计数字段会引入加减丢失/漂移类不一致，不存则这类问题根上不存在。更新时机仅三处：文档创建（批量 `INSERT OR IGNORE`，只对 ready 行）/ 覆盖更新（§9.2）/ 删除（快照 + CASCADE + 终态检查）。移动/重命名 md **零操作**（refs 挂 document_id）。**声明式扫描命中 pending 行时顺手 `created_at=now` 续期**（P2-6：封死"文本引用指向 pending 名 → 1h 回收释放名字 → 不同内容重用该名 → 引用静默指向新图"的窄洞）。

### 9.2 覆盖更新：集合差原子重算（不变量 R1）

> **R1**：覆盖上传的 refs 重算 = **单个同步事务内的集合差（set difference，非文本逐行 diff）**：`toAdd = new−old` 先 INSERT，`toRemove = old−new` 后 DELETE；GC 归零检查只对 toRemove 做、只在事务提交后、检查时重新 `COUNT(refs)==0` 才条件式软删。**严禁任何"先删后判归零再补插"的分步序列。**

推演关键场景（唯一引用者覆盖后仍引用同一图）：`I ∈ old∩new`（不变集）→ 不进 toAdd 也不进 toRemove → 引用原地不动从未归零，GC 检查名单上根本没有它——"先减到零再发现还要用"的中间态在集合差语义下结构性不存在。即使实现写成全删全加，同事务原子性下外部观察者（GC tick/渲染）也看不到中间态。

### 9.3 GC 三触发点（均遵守 §4.3 安全包）

- **文档删除**：删除事务内 SELECT 快照该 md（含子树全部 file 行，deleteNode 先例）的 refs 清单 → 删文档（CASCADE 清 refs）→ 逐图终态检查归零 → 条件式软删墓碑 → 事务后按 §4.3-2 反查删 blob
- **覆盖上传**：§9.2 的集合差重算；toRemove 触发同款归零检查
- **周期兜底**（分批 LIMIT）：pending 超 1h 物理删；ready 无 refs 超 24h 软删；**顺带清理悬空 ref**（`refs JOIN images WHERE status≠'ready'` 的行删除）。**P1-2（代码实证）：`startTieringScheduler` 须改为无条件启动**——现状 `tiering.ts` 在 `getObjectStore()` 为 null 时直接 return（未配对象存储则调度器不存在），而默认部署恰是 local 后端无对象存储 → 图片 GC 将永不运行（pending 名永不释放、存储无界增长）；修正后归档循环保留 store 判空 no-op，图片回收循环无外部依赖
- **单轮循环至清空（交叉审查修复批 P1）**：每 tick 的图片回收在单轮内 while 循环（上限 10000 防呆）直至无新回收行——固定批次大小会让回收吞吐追不上 init 产速（压力场景 pending 无界堆积），循环清空保证每 tick 结束时队列见底

### 9.4 不一致态的收敛（发现者 + 收敛器）

| 坏态 | 危害 | 发现者（防御） | 收敛器（最终修复） |
|---|---|---|---|
| 悬空 ref（指向非 ready 图） | 渲染占位不炸（替换只认 ready） | 渲染层天然防御 | 周期任务清行（§9.3） |
| 幽灵图（无 refs 该死未死） | 仅存储浪费 | 无需防御 | **24h 周期回收 = 全局收敛器** |
| 行 ready 但 blob 丢失（磁盘损坏/误删；仅顺序写反的 bug 亦可致） | 裂图 + exists 复用坏行 | **init exists 分支 head 探测（交叉审查修复批 P1：降级墓碑复活重传）** + serve 失败日志 | head 自愈（自动）；不变量测试锁定顺序 |
| 墓碑复活竞态残留 | 多余对象 | —— | 24h 收敛器 |

**总原则（不对称设计）：宁可晚删，绝不早删。** 晚删最坏代价 = 一份资源多占 24h（周期回收收敛）；早删 = 丢数据且部分不可自愈。全部机制（R1/终态判定/删 blob 反查/条件式写）服务于"早删不可能"，晚删交给常转的清洁工。

### 9.5 名字语义

pending 超时释放；ready 墓碑永不释放（90d 物理清理备案）。

## 10. 前端

- 正文图片样式：max-width 100%、圆角、cursor zoom-in、暗色柔和底色
- ImageLightbox（交互规格已定）：
  - **图集模式**：同文档全部图片成序列，←/→ 键 + 箭头按钮 + 移动端滑动切图，序号 `3 / 8`；**切图重置缩放为 100%**（每图独立状态）
  - **移动端手势按缩放状态切换角色**：1x 态单指横滑=切图（跟手位移，>1/4 屏或速度达标翻页，否则弹回）；>1x 态单指拖=平移，拖到边缘继续向外=阻尼弹回不翻页（防误切）；pinch 跨越 1x 即切角色。桌面无冲突（鼠标拖=平移，键盘/按钮=切图）
  - 打开/关闭动画：**淡入淡出**（v1 从简，FLIP 缩放过渡备案后续）
  - 工具栏与 mermaid 同构最小集：＋/−/重置(100%)/浏览器全屏/关闭；键盘 +/− 缩放顺手支持；下载按钮备案
  - 复用 mermaid 手势基建（`gestures`/`overlayOnMount` 抽 `$lib/shared/`；`mermaid-zoom` 泛化）——gestures 需扩展"1x 态横向滑动 → swipe 回调"挂点（mermaid 侧不启用不受影响）
  - 交互全集：拖动/pinch/滚轮锚定指针缩放/双击 1x⇄2.5x（锚定双击点）/Esc/焦点圈定/body 滚动锁；缩放 0.2x–10x；加载指示
  - 外链/base64/签名/代理图行为一致（纯展示变换，无 CORS 障碍）

## 11. 安全清单

- magic 白名单+扩展名一致（relay 上传时 + confirm 登记时双重）；SVG 拒绝
- 直传不信任链：confirm 三重验证 + serve 侧 Content-Type 白名单 + nosniff（mime 造假最坏裂图，无 XSS）
- presign 最小权限（单 key+短 TTL+不下发票据）；行 id 令牌 owner 作用域校验
- refs 白名单（代理路由）；签名 URL TTL 1h；token 不进 referrer
- 限流：init/confirm 轻桶 120/min + relay/documents 重桶 60/min + authfail IP 桶
- BODY_SIZE_LIMIT 启动校验联动；占位符自指防冲突

## 12. env 变更

| env | 默认 | 说明 |
|---|---|---|
| `IMAGE_STORE_BACKEND` | `local` | `local` \| `s3`（选 s3 需 OBJECT_STORE_* 齐全，启动校验） |
| `MAX_IMAGE_BYTES` | `10485760` | 单图原始字节上限 |
| `IMAGE_SIGNED_URL_TTL` | `3600` | 取图签名有效期秒（桶对齐下实际有效期 TTL ~ TTL+桶宽，设期望值 ~1.2 倍可覆盖） |
| `IMAGE_PROXY_ALL` | `0` | 强制全代理 |

同步 `.env.example`/`env.ts`/`startup-check.ts`/INSTALL.md/USER_GUIDE。BODY_SIZE_LIMIT 启动校验为**双下限取 max**：`max(MAX_UPLOAD_BYTES×1.5, MAX_IMAGE_BYTES×1.37×1.5)`。

## 13. 测试计划

- init 四分支/名字后缀（并发/上限/超长截断/精确 `=` 探测）/轻桶限流/413 预检/**hash·md5 hex 格式拒绝（P0-1）**
- relay 验证链/**owner 作用域（P2-1）**/**sha256 字节绑定（P1-1：谎报 hash+异字节必须 invalid）**/UPDATE 条件式/0 行回查
- confirm 三态/ETag 强校验默认+退化开关语义（P2-5）/幂等重放/GC 后 confirm→missing/invalid 删对象
- GC 安全包五不变量各设场景测试（条件式竞态/删 blob 反查/补录事务边界/软删复查）
- **local 模式（无对象存储）下图片周期 GC 实际运行（P1-2：scheduler 无条件启动）**
- **提取器三消费方一致性（P1-3）：shared 单源提取函数对同一 md 在桥预检/上传登记/渲染三处产出相同 names[]，含 math 吞图语义差锁定**
- **补录 content-hash 守卫（P1-4）：渲染期间覆盖上传，旧渲染不得补录已移除引用**
- 墓碑：名字占位/复活全字段重置/并发复活/pending 命中续期（P2-6）
- 渲染：占位符自指/两段管线/**两函数签名分离（渲染无上下文参数）**/缓存命中仍替换/裂图/**name encodeURIComponent（`#`/`%`/`&` 名字用例）**/缓存键隔离/referrerpolicy/桶对齐（同桶 URL 逐字节相同）/悬空 ref 周期清理
- 代理路由缓存：no-cache+ETag 协商 304 / 撤销 token 后协商 404（即时性验证）/ onerror 兜底（Playwright 拦截请求模拟 CDN 失败）
- 桥：六类错误/两阶段/双通道/进度摘要/token 解析不误伤/**429 退避重试**
- 冷档溯源回归；startup-check；schema↔ensureSchema 等价性
- **测试基建（交叉审查修复批）**：vitest 4 下 `pool/poolOptions` 必须置于 config 顶层（test 级字段被静默忽略）且 `pool: 'forks', poolOptions: { singleFork: true }`——better-sqlite3 原生 addon + 单 DB 文件的测试隔离前提；fire-and-forget 轮询断言须多轮 flush 沉降（高负载下线程池回调可晚于单轮 setImmediate）
- Playwright：relay+direct 双模式全链路 + lightbox 交互 + 删文档图 404

## 14. 已知权衡与备案

| 项 | 说明 |
|---|---|
| 七牛 ETag=MD5 口径 | 实测；不标准 → confirm 退化 magic+size |
| 七牛 presign PUT 签 Content-Type | 实测；不签则 magic 兜底 |
| 七牛 2026-04-08 新空间政策 | 新建空间浏览器直连强制 attachment——`<img>` 子资源是否受影响**上线前实测**；中招则文档指引自定义域名/旧空间 |
| 七牛 S3 空间名 ≠ 空间名 | presign Bucket 必须用 S3 空间名（控制台查）——INSTALL 写明 |
| Referer 配置口径 | 白名单填站点域名（无 scheme；`*.` 不含裸域）；「允许空 Referer」建议开启（门禁靠签名） |
| 签名 URL 撤销残留 | 撤销分享后 ≤TTL 内已分发 URL 仍可取图 |
| 无行孤儿 blob | confirm 前崩溃的云对象（key 内容寻址，重传覆盖消化）+ relay 写盘后插行前崩溃 |
| 独立 upload_image MCP 工具 / 资产管理 UI / 图片内容版本 / width-height 防 CLS / 桥 hash 缓存 | 后续 |
| backend_meta 列 / 墓碑 90d 物理清理 | 等真实消费者 |
| 有 refs 的 local 图永不分层 | 接受（图片小，冷热分层初衷是文档） |
| **换后端须保留旧后端 env**（P2-7） | `IMAGE_STORE_BACKEND` 切到 local 且删除 OBJECT_STORE_* → 旧 s3 图行查无实现 503——与冷档现状行为一致；INSTALL 写明：切换后保留旧后端 env 直至旧行清空/迁移完成 |
| CSP 转 enforcing 时 | img-src 须放行 CDN 域名（当前 report-only/未设不受影响） |
| 占位符离线碰撞 | 2^32 sha256 前缀离线可碰撞，但伪造者只能命中自己文档的 names[]（owner 作用域），无跨用户影响——接受 |
| 桥 resolveLocal 相对路径（交叉审查备案） | 预检的本地路径解析以桥 cwd 为基准——Agent 本就能在宿主机任意读文件（既有能力面，非新增暴露）；Web 侧 storage_key 恒 hex 内容寻址 + 魔数限四种格式，无穿越落盘路径 |
| confirm ETag 缺失网关的 md5 降级（交叉审查备案） | 网关 head 不返回 ETag 时（`head.etag === undefined`）跳过 md5 诚实性比对，仅余 magic+size+扩展名三重——key 为 per-owner 内容寻址，毒害面限于 owner 自己的池（无跨 owner 路径），且主流 S3 网关（含七牛）单段 PUT ETag=MD5 可用 |

## 15. 实现现状

**已全量交付（2026-09-21）**：五批实现（P1 存储层 / P2 Web API+GC / P3 渲染管线 / P4 桥编排 / P5 前端收官）+ 两批交叉审查修复（批 A：relay/confirm 路由 503 映射、GC 单轮循环至清空、initImage exists 分支 head 探测自愈、vitest singleFork 配置补正等；批 B：存储错误类迁独立模块解循环依赖、双代理路由收敛 `serveImageResponse`、浏览器全屏 `use:browserFullscreen` 三组件收敛、confirm 补扩展名一致校验 + `extsForMime` 上移 shared 单源、并发墓碑复活测试、spec 备案补录）。测试 703 全绿 + svelte-check 0 错 + 桥 tsc 0 错 + e2e-check.sh 图片七段冒烟 + e2e-images.mjs Lightbox 11 断言。实现细节与各修复的完整记录以 `AGENTS.md` 为权威（本 spec 保留设计决策与备案）。已知 v1 从简偏离（swipe 非跟手/双击锚定近似/超界平移无阻尼）见 §10 与 AGENTS.md。
