# 图片支持 · Phase 1：存储层 + DB + BlobStore 插件体系 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地图片资产池的数据库表（images / image_refs / documents.storage_backend）、BlobStore 无状态接口与 local/s3 双实现、注册表与启动校验——为后续 API/渲染/桥编排提供地基。

**Architecture:** 新表进 `SCHEMA_SQL`（`CREATE TABLE IF NOT EXISTS` 天然覆盖新库与存量库，无需单独 ensure 函数；documents 加列走 `ensureDocumentsStorageBackendColumn` 先例模式 + 冷档回填）。BlobStore 为**新建独立模块**（`blobstore.ts` 接口+注册表 / `blobstore-local.ts` / `blobstore-s3.ts`），与现有 `object-store.ts`（string 语义）**并存零改动**——Phase 5 冷却收敛时再迁移消费者删除旧实现（接受 ~80 行 S3Client 构建的短暂重复，换取本批零风险）。

**Tech Stack:** better-sqlite3 + Drizzle（schema.ts 声明 / SCHEMA_SQL 手写 / drizzle-kit 迁移三源同步 + 守卫测试）、`@aws-sdk/client-s3`（已装）+ `@aws-sdk/s3-request-presigner`（本批新增）、node:fs/promises。

**Spec:** `docs/superpowers/specs/2026-09-20-image-support-design.md` v4（§4 数据模型、§8 BlobStore 与插件体系、§12 env）。

**五批路线图**（每批独立可验收，执行完一批再写下一批计划）：
1. **本计划**：存储层 + DB + BlobStore 插件体系
2. Web API（init/relay/confirm/双代理路由）+ 引用管理与 GC 三触发点
3. 渲染管线（shared 提取器单源 / renderMarkdown 两函数分离 / 占位符替换）
4. MCP 桥编排（两阶段 / 六类错误 / 双通道）
5. 前端 Lightbox + 冷却通用化收敛 + e2e + 文档

**env 分批边界**（防"遗漏"误判）：spec §12 共四个新 env——本批只加有消费者的两个（`IMAGE_STORE_BACKEND` / `MAX_IMAGE_BYTES`）；`IMAGE_SIGNED_URL_TTL` 与 `IMAGE_PROXY_ALL` 的消费者在渲染管线，**Phase 3 随实现一起加**（先加 getter 无消费者 = 死代码，违反项目"不做推测性设计"准则）。

---

## Task 0: worktree 准备（执行前置，一次性）

- [ ] **Step 1: 创建 worktree 并安装依赖**

本批为功能代码，按 `AGENTS.local.md` 纪律在 worktree 副本执行（可用 superpowers:using-git-worktrees 或 `git worktree add ../rr-img1 -b feat/image-support-phase1`）。进入副本后：

```bash
bun install    # bun 全局缓存硬链接，秒级；data/ 为 gitignore，副本天然用独立测试库
```

- [ ] **Step 2: 基线验证（改动前全绿基线）**

```bash
bun run test && bun --filter remote-reader-web check
```

Expected: 全部 PASS / 0 errors——后续任何"回归"都有干净基线可对照。

---

## 运行时纪律（全批通用，每个 Task 的验证命令都遵守）

- 测试：`bun run test apps/web/tests/<file>.test.ts`（vitest，node 运行时；不要用 `bun` 直接跑测试文件——better-sqlite3 原生 addon 在 bun 下加载失败）
- 类型检查：`bun --filter remote-reader-web check`
- **worktree 纪律**：本批是功能代码，必须在 worktree 副本中执行（`AGENTS.local.md` 规则；master 主工作区只进文档）
- 运行时分工：dev/build 用 bun；不要 `node apps/web/build/index.js` 以外的方式起生产服务

---

### Task 1: schema.ts 加 drizzle 声明（images / imageRefs / documents.storageBackend）

**Files:**
- Modify: `apps/web/src/lib/server/db/schema.ts`

- [ ] **Step 1: 在 `documents` 表定义的 `ownerViewedAt` 行后追加列声明**

```ts
    // 「最近浏览」信号（spec §5.1）：仅 owner 真实浏览（beacon 写入）；
    // 与 last_viewed_at（分层信号：任何人任何访问）语义分工，互不替代
    ownerViewedAt: integer('owner_viewed_at'),
    // 图片支持（spec 2026-09-20 §4.1）：冷档溯源列——NULL=hot（本地盘）；非空=cold 行的实际归档后端
    storageBackend: text('storage_backend')
```

- [ ] **Step 2: 在 `documentTags` 表定义之后追加两个新表**

```ts
// 图片资产池（spec 2026-09-20 §4.1）：owner 内内容寻址去重，脱离 documents 目录树。
// status 三态：pending（init 存根）/ ready（可引用可 serve）/ deleted（墓碑——UNIQUE 占位实现名字永不复用）
export const images = sqliteTable('images', {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull().references(() => users.id),
    name: text('name').notNull(),
    contentHash: text('content_hash').notNull(),
    contentMd5: text('content_md5').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status', { enum: ['pending', 'ready', 'deleted'] }).notNull().default('pending'),
    storageBackend: text('storage_backend').notNull(),
    storageKey: text('storage_key').notNull(),
    createdAt: integer('created_at').notNull(),
    readyAt: integer('ready_at')
}, (t) => ({
    ownerHashUniq: uniqueIndex('images_owner_hash_uniq').on(t.ownerId, t.contentHash),
    ownerNameUniq: uniqueIndex('images_owner_name_uniq').on(t.ownerId, t.name),
    statusCreatedIdx: index('images_status_created_idx').on(t.status, t.createdAt),
    statusReadyIdx: index('images_status_ready_idx').on(t.status, t.readyAt)
}));

// md ↔ 图片引用关系（N:N，兼代理路由 refs 白名单）；ON DELETE CASCADE 随文档删除清 refs
export const imageRefs = sqliteTable('image_refs', {
    documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    imageId: text('image_id').notNull().references(() => images.id),
    createdAt: integer('created_at').notNull()
}, (t) => ({
    pk: primaryKey({ columns: [t.documentId, t.imageId] }),
    imageIdx: index('image_refs_image_id_idx').on(t.imageId)
}));
```

（**命名备案**：索引名与 spec §4.1 的裸名（`images_status_created` 等）**有意不同**——统一带 `_idx`/`_uniq` 后缀随仓库惯例（db-init 守卫测试的 expectedIndexes 全带后缀）；Phase 2+ 实现按本计划名单为准，勿按 spec 字面名查询）

- [ ] **Step 3: 类型检查通过**

Run: `bun --filter remote-reader-web check`
Expected: 0 errors（新表无人消费，纯声明）

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/lib/server/db/schema.ts
git commit -m "feat(web): 图片支持——schema.ts 声明 images/image_refs 表与 documents.storage_backend 列"
```

---

### Task 2: SCHEMA_SQL 同步 + documents 加列兜底 + 冷档回填（TDD）

**Files:**
- Modify: `apps/web/src/lib/server/db/index.ts`（SCHEMA_SQL 追加 + `ensureDocumentsStorageBackendColumn`）
- Test: `apps/web/tests/images-schema.test.ts`（新建）

- [ ] **Step 1: 写失败测试（新文件 `apps/web/tests/images-schema.test.ts`）**

```ts
import { describe, it, expect, beforeAll } from 'vitest';
import { sqlite, ensureSchema } from '$server/db';
import { resetDb } from './helpers';

// 三源一致性守卫（spec §4.1）：SCHEMA_SQL（新库路径）/ ensureSchema（存量库路径）/ drizzle 迁移（db:migrate 路径）
// 对 images / image_refs / documents.storage_backend 的结构断言。
// 注：测试库由根 vitest.config.ts 统一管理（共享 ./data/app.db，helpers.ts 不设 DATABASE_PATH）；
// db/index.ts 模块加载即执行 ensureSchema()（含新表），beforeAll resetDb 保证起点数据干净。
beforeAll(() => resetDb()); // 起点干净，桩数据不泄漏到后续测试文件

describe('images schema', () => {
    it('images 表存在且列齐全', () => {
        const cols = sqlite.prepare('PRAGMA table_info(images)').all() as { name: string }[];
        const names = new Set(cols.map((c) => c.name));
        for (const c of [
            'id', 'owner_id', 'name', 'content_hash', 'content_md5', 'mime_type',
            'size_bytes', 'status', 'storage_backend', 'storage_key', 'created_at', 'ready_at'
        ]) expect(names.has(c), `缺列 ${c}`).toBe(true);
    });

    it('images 双 UNIQUE + 两回收索引存在', () => {
        const idx = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='images'")
            .all() as { name: string }[];
        const names = new Set(idx.map((i) => i.name));
        for (const n of ['images_owner_hash_uniq', 'images_owner_name_uniq', 'images_status_created_idx', 'images_status_ready_idx']) {
            expect(names.has(n), `缺索引 ${n}`).toBe(true);
        }
    });

    it('image_refs 复合主键 + image_id 索引 + document_id 级联', () => {
        const idx = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='image_refs'")
            .all() as { name: string }[];
        expect((idx.map((i) => i.name)).includes('image_refs_image_id_idx')).toBe(true);
        const fk = sqlite.prepare('PRAGMA foreign_key_list(image_refs)').all() as
            { table: string; from: string; on_delete: string }[];
        const docFk = fk.find((f) => f.table === 'documents' && f.from === 'document_id');
        expect(docFk?.on_delete).toBe('CASCADE');
    });

    it('documents.storage_backend 列存在（存量库升级兜底）', () => {
        const cols = sqlite.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
        expect((cols.map((c) => c.name)).includes('storage_backend')).toBe(true);
    });

    it('存量冷档行回填 storage_backend=s3（幂等）', () => {
        // 先手工造一行 cold（绕过服务层直接插桩数据）
        sqlite.exec(`INSERT INTO users (id, email, password_hash, role, created_at)
            VALUES ('u-sb', 'sb@test.local', 'x', 'member', 0)`);
        sqlite.exec(`INSERT INTO documents (id, owner_id, parent_id, name, type, created_at, updated_at, storage_tier)
            VALUES ('d-sb', 'u-sb', NULL, 'cold.md', 'file', 0, 0, 'cold')`);
        ensureSchema(sqlite); // 再跑一次：回填幂等
        const row = sqlite.prepare("SELECT storage_backend FROM documents WHERE id='d-sb'").get() as { storage_backend: string | null };
        expect(row.storage_backend).toBe('s3');
        const hot = sqlite.prepare("SELECT storage_backend FROM documents WHERE storage_tier='hot' LIMIT 1").get() as { storage_backend: string | null } | undefined;
        expect(hot === undefined || hot.storage_backend === null).toBe(true); // hot 行保持 NULL
    });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/images-schema.test.ts`
Expected: FAIL（`no such table: images` / 缺 storage_backend 列）

- [ ] **Step 3: 实现——SCHEMA_SQL 末尾（`docs_fts` 虚拟表之前）追加建表与索引**

在 `apps/web/src/lib/server/db/index.ts` 的 SCHEMA_SQL 中、`CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts` 行之前插入：

```sql
CREATE TABLE IF NOT EXISTS images (
    id text PRIMARY KEY NOT NULL,
    owner_id text NOT NULL,
    name text NOT NULL,
    content_hash text NOT NULL,
    content_md5 text NOT NULL,
    mime_type text NOT NULL,
    size_bytes integer NOT NULL,
    status text NOT NULL DEFAULT 'pending',
    storage_backend text NOT NULL,
    storage_key text NOT NULL,
    created_at integer NOT NULL,
    ready_at integer,
    FOREIGN KEY (owner_id) REFERENCES users(id) ON UPDATE no action ON DELETE no action
);
CREATE UNIQUE INDEX IF NOT EXISTS images_owner_hash_uniq ON images (owner_id, content_hash);
CREATE UNIQUE INDEX IF NOT EXISTS images_owner_name_uniq ON images (owner_id, name);
CREATE INDEX IF NOT EXISTS images_status_created_idx ON images (status, created_at);
CREATE INDEX IF NOT EXISTS images_status_ready_idx ON images (status, ready_at);
CREATE TABLE IF NOT EXISTS image_refs (
    document_id text NOT NULL,
    image_id text NOT NULL,
    created_at integer NOT NULL,
    FOREIGN KEY (document_id) REFERENCES documents(id) ON UPDATE no action ON DELETE cascade,
    FOREIGN KEY (image_id) REFERENCES images(id) ON UPDATE no action ON DELETE no action,
    PRIMARY KEY (document_id, image_id)
);
CREATE INDEX IF NOT EXISTS image_refs_image_id_idx ON image_refs (image_id);
```

- [ ] **Step 4: 实现——`ensureDocumentsStorageBackendColumn`（照 `ensureOwnerViewedColumn` 先例），并在 `ensureSchema` 中调用**

在 `ensureOwnerViewedColumn` 函数后追加：

```ts
// 图片支持（spec §4.1）：documents 冷档溯源列——存量库 ALTER 兜底 + 存量 cold 行一次性回填 's3'
// （现状唯一归档后端；幂等：WHERE storage_backend IS NULL 使回填只补不覆盖）
export function ensureDocumentsStorageBackendColumn(target: SqliteDb): void {
    const cols = target.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    if (!cols.some((c) => c.name === 'storage_backend')) {
        target.exec('ALTER TABLE documents ADD COLUMN storage_backend text');
    }
    target.exec("UPDATE documents SET storage_backend = 's3' WHERE storage_tier = 'cold' AND storage_backend IS NULL");
}
```

在 `ensureSchema` 内 `ensureOwnerViewedColumn(target);` 之后追加一行：

```ts
    ensureDocumentsStorageBackendColumn(target);
```

- [ ] **Step 4: 同步 A-2 等价性守卫测试（必改，非可选——本步遗漏则 Task 2 的 commit 即处于红测试状态）**

`apps/web/tests/db-init.test.ts` 的守卫测试使用**硬编码清单**（documents 列清单 + `expectedIndexes` 的 `tbl_name IN (...)` 表清单）。本 Task 的 SCHEMA_SQL/加列改动使其立即失配，须同步三处：

1. documents 列清单追加 `'storage_backend'`
2. `expectedIndexes` 的表清单 `IN (...)` 追加 `'images'`、`'image_refs'`
3. `expectedIndexes` 增补四个索引行：`images_owner_hash_uniq` / `images_owner_name_uniq` / `images_status_created_idx` / `images_status_ready_idx` / `image_refs_image_id_idx`（按该文件现有行格式）

- [ ] **Step 5: 跑测试确认通过（新守卫 + 存量守卫双绿）**

Run: `bun run test apps/web/tests/images-schema.test.ts apps/web/tests/db-init.test.ts`
Expected: PASS（5 + 存量全绿——确保本 Task 的 commit 不留红测试）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/server/db/index.ts apps/web/tests/images-schema.test.ts apps/web/tests/db-init.test.ts
git commit -m "feat(web): 图片支持——SCHEMA_SQL 建 images/image_refs + documents.storage_backend 兜底回填 + A-2 守卫同步（TDD）"
```

---

### Task 3: 生成 Drizzle 迁移 0008 + 冒烟

**Files:**
- Create: `apps/web/src/lib/server/db/migrations/0008_*.sql`（drizzle-kit 自动生成）
- Modify: `apps/web/tests/helpers.ts`（resetDb 清表清单加 images / image_refs）

- [ ] **Step 1: 生成迁移**

Run: `bun --filter remote-reader-web db:generate`
Expected: 生成 `apps/web/src/lib/server/db/migrations/0008_<name>.sql`，内容含 `CREATE TABLE images` / `CREATE TABLE image_refs` / `ALTER TABLE documents ADD storage_backend`。**目检**：与 Task 2 的 SCHEMA_SQL 逐索引对照，索引名必须完全一致（三源一致）。**若生成物是 sqlite 表重建形态**（drizzle-kit 对部分 DDL 会生成 create-new-copy-rename 脚本）：纯加列场景可手编简化为单条 `ALTER TABLE "documents" ADD "storage_backend" text;`（drizzle 迁移文件允许手编，保持语句幂等性靠 ensureSchema 兜底而非迁移本身）；新表保持生成的 CREATE 即可。修 schema.ts 或手编后重新目检。

- [ ] **Step 2: 迁移执行冒烟（独立临时库；node 段在 apps/web 目录跑——bun workspaces 下仓库根解析不到 better-sqlite3）**

Run: `DATABASE_PATH=/tmp/opencode/img-migrate-smoke.db bun --filter remote-reader-web db:migrate`
Expected: 无报错。

Run（**workdir = `apps/web`**）:
```bash
DATABASE_PATH=/tmp/opencode/img-migrate-smoke.db node -e "const D=require('better-sqlite3');const db=new D('/tmp/opencode/img-migrate-smoke.db');console.log(db.prepare(\"SELECT name FROM sqlite_master WHERE name IN ('images','image_refs')\").all());db.close()"
```
Expected: 输出包含 `images` 与 `image_refs`。（用 node 直跑 better-sqlite3，符合运行时分工；若 drizzle.config 的 dbCredentials 硬编码了路径而非读 DATABASE_PATH，先核对配置再冒烟）
完成后删除冒烟库：`rm /tmp/opencode/img-migrate-smoke.db`

- [ ] **Step 3: resetDb 清表清单同步**

`apps/web/tests/helpers.ts` 的 resetDb 使用 drizzle 风格（`db.delete(schema.X).run()`，无裸 SQL 序列）。在清表序列**最前**（imageRefs 先于 images，均在 documents/users 之前——遵守外键依赖顺序）追加：

```ts
    db.delete(schema.imageRefs).run();
    db.delete(schema.images).run();
```

（A-2 守卫测试已在 Task 2 Step 4 同步——本步只动 resetDb）

- [ ] **Step 4: 全量测试回归（确认 resetDb 改动无破坏）**

Run: `bun run test`
Expected: 全部 PASS（存量 ~460+ 用例，无新失败）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/db/migrations/ apps/web/tests/helpers.ts
git commit -m "feat(web): 图片支持——drizzle 迁移 0008 + resetDb 覆盖新表"
```

---

### Task 4: env getter（IMAGE_STORE_BACKEND / MAX_IMAGE_BYTES）

**Files:**
- Modify: `apps/web/src/lib/server/env.ts`
- Test: `apps/web/tests/env.test.ts`（扩展）

- [ ] **Step 1: 写失败测试（追加到 `apps/web/tests/env.test.ts`）**

```ts
describe('getImageStoreBackend / getMaxImageBytes', () => {
    it('默认 local / 10MB', () => {
        delete process.env.IMAGE_STORE_BACKEND;
        delete process.env.MAX_IMAGE_BYTES;
        expect(getImageStoreBackend()).toBe('local');
        expect(getMaxImageBytes()).toBe(10 * 1024 * 1024);
    });
    it('合法值 s3 / 自定义字节', () => {
        process.env.IMAGE_STORE_BACKEND = 's3';
        process.env.MAX_IMAGE_BYTES = '2097152';
        expect(getImageStoreBackend()).toBe('s3');
        expect(getMaxImageBytes()).toBe(2097152);
        delete process.env.IMAGE_STORE_BACKEND;
        delete process.env.MAX_IMAGE_BYTES;
    });
    it('非法后端值 fail-fast', () => {
        process.env.IMAGE_STORE_BACKEND = 'ftp';
        expect(() => getImageStoreBackend()).toThrow('IMAGE_STORE_BACKEND');
        delete process.env.IMAGE_STORE_BACKEND;
    });
});
```

（文件顶部 import 区补 `getImageStoreBackend, getMaxImageBytes`——若该文件用 `import * as env` 风格则按现状适配。**该文件现有 afterEach 只清理固定键清单**——须把 `IMAGE_STORE_BACKEND` / `MAX_IMAGE_BYTES` 加入该清单，防用例中途断言失败时泄漏 env 到后续测试文件（如 blobstore.test.ts 依赖 local 默认值））

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/env.test.ts`
Expected: FAIL（函数未导出）

- [ ] **Step 3: 实现（`apps/web/src/lib/server/env.ts` 末尾追加）**

```ts
// —— 图片支持（spec 2026-09-20 §12）——
export type ImageStoreBackend = 'local' | 's3';

export function getImageStoreBackend(): ImageStoreBackend {
    const raw = process.env.IMAGE_STORE_BACKEND ?? 'local';
    if (raw !== 'local' && raw !== 's3') {
        throw new Error(`env IMAGE_STORE_BACKEND 须为 local 或 s3，实际值: ${JSON.stringify(raw)}`);
    }
    return raw;
}

export function getMaxImageBytes(): number {
    return envInt('MAX_IMAGE_BYTES', 10 * 1024 * 1024);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/env.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/env.ts apps/web/tests/env.test.ts
git commit -m "feat(web): 图片支持——IMAGE_STORE_BACKEND/MAX_IMAGE_BYTES env getter（TDD）"
```

---

### Task 5: BlobStore 接口 + 注册表 + 测试钩子

**Files:**
- Create: `apps/web/src/lib/server/blobstore.ts`
- Test: `apps/web/tests/blobstore.test.ts`（新建）

- [ ] **Step 1: 写失败测试（注册表路由语义，`apps/web/tests/blobstore.test.ts`）**

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getBlobStore, getActiveImageStore, __setBlobStoresForTest } from '$server/blobstore';
import { LocalBlobStore } from '$server/blobstore-local';

describe('blobstore 注册表', () => {
    beforeEach(() => __setBlobStoresForTest(undefined));
    afterEach(() => __setBlobStoresForTest(undefined));

    it('local 恒注册且为默认 active', () => {
        const s = getActiveImageStore();
        expect(s.id).toBe('local');
        expect(getBlobStore('local')).toBeInstanceOf(LocalBlobStore);
    });

    it('未配 OBJECT_STORE_* 时 s3 不注册，查询返回 null', () => {
        delete process.env.OBJECT_STORE_ENDPOINT;
        expect(getBlobStore('s3')).toBeNull();
    });

    it('IMAGE_STORE_BACKEND=s3 但 s3 未注册 → active 抛错（运行时防御，startup-check 先拦）', () => {
        process.env.IMAGE_STORE_BACKEND = 's3';
        delete process.env.OBJECT_STORE_ENDPOINT;
        __setBlobStoresForTest(undefined); // 清缓存重算
        expect(() => getActiveImageStore()).toThrow(/s3/);
        delete process.env.IMAGE_STORE_BACKEND;
    });

    it('测试钩子可注入 fake', () => {
        const fake = new LocalBlobStore();
        __setBlobStoresForTest({ local: fake });
        expect(getBlobStore('local')).toBe(fake);
    });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/blobstore.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 `apps/web/src/lib/server/blobstore.ts`**

```ts
import { getImageStoreBackend } from './env';
import { parseObjectStoreEnv, type ObjectStoreConfig } from './object-store';
import { LocalBlobStore } from './blobstore-local';
import { S3BlobStore } from './blobstore-s3';

// BlobStore：无状态字节存储插件接口（spec 2026-09-20 §8）。
// 契约：插件只认 key 与字节——mime/size/hash 等元数据全在 DB 行，存储层不理解内容。
// 演进纪律（#27）：只能加可选成员，禁止加必选、禁止删改既有签名；能力用运行时探测（if (store.presign)）。
// key 由核心分配传入：local '<ownerId>/blobs/<h2>/<hash>' / s3 'images/<ownerId>/<hash>'（per-owner 内容寻址）。
// ⚠️ 依赖方向约束：blobstore-local.ts / blobstore-s3.ts 对本文件必须 `import type`（type-only）——
//    值导入会形成 blobstore → blobstore-s3 → blobstore 运行时循环。
export interface BlobStore {
    readonly id: string;
    /** presigned PUT URL 的建议有效期（秒）；慢后端可自声明更长。默认 600 */
    readonly uploadUrlTtlSeconds?: number;
    put(key: string, data: Buffer, contentType?: string): Promise<void>;
    get(key: string): Promise<Buffer>;
    head?(key: string): Promise<{ size: number; etag?: string }>);
    /** 读 [start, end] 闭区间字节（confirm 魔数预判 32B = getRange(key, 0, 31)） */
    getRange?(key: string, start: number, end: number): Promise<Buffer>;
    delete(key: string): Promise<void>;
    presign?(op: 'get' | 'put', key: string, ttlSeconds: number, opts?: Record<string, string>): Promise<string>;
}

// s3 注册条件（P2-7 语义）：OBJECT_STORE_* 配置齐全即注册——即使 IMAGE_STORE_BACKEND=local，
// 旧 s3 行的读取仍能路由到 s3 实现（换后端不炸旧图；彻底删除 env 才会 503，INSTALL 有文档）
function buildRegistry(): Map<string, BlobStore> {
    const m = new Map<string, BlobStore>();
    m.set('local', new LocalBlobStore());
    const s3config = parseObjectStoreEnv();
    if (s3config !== null) {
        m.set('s3', new S3BlobStore(s3config));
    }
    return m;
}

let registry: Map<string, BlobStore> | undefined;

/** 按 id 查已注册插件；未注册返回 null（调用方转 503/裂图占位） */
export function getBlobStore(id: string): BlobStore | null {
    if (registry === undefined) registry = buildRegistry();
    return registry.get(id) ?? null;
}

/** 当前 env 选定的 active 插件（写入路径用）；选了 s3 但未注册 → 抛错（确定性配置错误） */
export function getActiveImageStore(): BlobStore {
    const wanted = getImageStoreBackend();
    const store = getBlobStore(wanted);
    if (store === null) {
        throw new Error(`IMAGE_STORE_BACKEND=${wanted} 但该后端未注册（s3 需 OBJECT_STORE_* 五项配置齐全）`);
    }
    return store;
}

// 仅供测试：覆写/重置注册表（undefined = 下次访问重算）
export function __setBlobStoresForTest(stores: { local: BlobStore } | undefined): void {
    registry = stores === undefined ? undefined : new Map(Object.entries(stores));
}
```

- [ ] **Step 4: 创建最小 `apps/web/src/lib/server/blobstore-local.ts`（空壳，Task 6 填满）**

```ts
import type { BlobStore } from './blobstore';

export class LocalBlobStore implements BlobStore {
    readonly id = 'local';
    async put(): Promise<void> { throw new Error('TODO Task 6'); }
    async get(): Promise<Buffer> { throw new Error('TODO Task 6'); }
    async delete(): Promise<void> { throw new Error('TODO Task 6'); }
}
```

（注：这是 Task 6 的实现桩——仅让 Task 5 的注册表测试可跑；Task 6 立即替换为真实现。**不是计划占位符**，是任务间的编译依赖顺序。）

同时创建 `apps/web/src/lib/server/blobstore-s3.ts` 空壳（Task 7 填满）：

```ts
import type { BlobStore } from './blobstore';
import type { ObjectStoreConfig } from './object-store';

export class S3BlobStore implements BlobStore {
    readonly id = 's3';
    constructor(_config: ObjectStoreConfig) { void _config; }
    async put(): Promise<void> { throw new Error('TODO Task 7'); }
    async get(): Promise<Buffer> { throw new Error('TODO Task 7'); }
    async delete(): Promise<void> { throw new Error('TODO Task 7'); }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run test apps/web/tests/blobstore.test.ts`
Expected: PASS（4 个用例——注册表语义不触盘）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/server/blobstore.ts apps/web/src/lib/server/blobstore-local.ts apps/web/src/lib/server/blobstore-s3.ts apps/web/tests/blobstore.test.ts
git commit -m "feat(web): 图片支持——BlobStore 接口与注册表（local 恒注册/s3 随 OBJECT_STORE_* 注册，P2-7）"
```

---

### Task 6: LocalBlobStore 完整实现（TDD）

**Files:**
- Modify: `apps/web/src/lib/server/blobstore-local.ts`
- Test: `apps/web/tests/blobstore-local.test.ts`（新建）

- [ ] **Step 1: 写失败测试**

```ts
import { describe, it, expect, afterAll } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalBlobStore } from '$server/blobstore-local';
import { ObjectNotFoundError } from '$server/object-store';

const DIR = mkdtempSync(join(tmpdir(), 'rr-blob-'));
// DATA_DIR 指向临时目录——必须在任何 store 调用前设置（LocalBlobStore 每次调用时读 getDataDir()）；
// afterAll 恢复：vitest 单 worker 共享 process.env，不恢复会泄漏到后续测试文件
process.env.DATA_DIR = DIR;
afterAll(() => {
    delete process.env.DATA_DIR;
    rmSync(DIR, { recursive: true, force: true });
});

describe('LocalBlobStore', () => {
    const store = new LocalBlobStore();
    // key = <ownerId>/blobs/<h2>/<hash>（per-owner 内容寻址，DATA_DIR 为根）
    const KEY = 'u-123/blobs/ab/abcdef0123';

    it('put→get 往返字节一致（Buffer）', async () => {
        const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
        await store.put(KEY, data, 'image/png');
        expect(await store.get(KEY)).toEqual(data);
    });

    it('put 幂等覆盖（同 key 重写）', async () => {
        await store.put(KEY, Buffer.from([1, 2, 3]));
        await store.put(KEY, Buffer.from([4, 5]));
        expect((await store.get(KEY)).length).toBe(2);
    });

    it('head 返回 size', async () => {
        await store.put(KEY, Buffer.alloc(1234));
        const h = await store.head!(KEY);
        expect(h.size).toBe(1234);
        expect(h.etag).toBeUndefined(); // local 无 ETag（confirm 的 md5 校验仅 s3 路径）
    });

    it('getRange 读局部（confirm 魔数预判用）', async () => {
        const data = Buffer.alloc(100, 7);
        await store.put(KEY, data);
        const head = await store.getRange!(KEY, 0, 31);
        expect(head.length).toBe(32);
        expect(head[0]).toBe(7);
    });

    it('get 未命中 → ObjectNotFoundError（404 语义）', async () => {
        await expect(store.get('u-123/blobs/00/nonexistent')).rejects.toBeInstanceOf(ObjectNotFoundError);
    });

    it('delete 后 get 抛 NotFound；delete 幂等（ENOENT 视为成功）', async () => {
        await store.delete(KEY);
        await expect(store.get(KEY)).rejects.toBeInstanceOf(ObjectNotFoundError); // 用例名的前半断言
        await expect(store.delete(KEY)).resolves.toBeUndefined();
    });

    it('key 含路径穿越段 → 拒绝（纵深防御，key 本应恒为服务端生成）', async () => {
        await expect(store.get('../escape')).rejects.toThrow();
        await expect(store.put('a/../../escape', Buffer.from('x'))).rejects.toThrow();
    });
});
```

（`getRange` 语义为闭区间 `[start, end]`——测试 `getRange(KEY, 0, 31)` 期望 32 字节与接口 JSDoc 一致）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/blobstore-local.test.ts`
Expected: FAIL（TODO Task 6 抛错）

- [ ] **Step 3: 实现（替换空壳）**

```ts
import { mkdir, readFile, stat, unlink, open, writeFile as fsWrite, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDataDir } from './env';
import { ObjectNotFoundError } from './object-store';
import type { BlobStore } from './blobstore';

// local 插件（spec §8）：DATA_DIR/<ownerId>/blobs/<hash前2>/<hash> 内容寻址布局。
// key 由核心分配（hex 校验后的 hash 拼成），实现内再防穿越一层（纵深防御）。
export class LocalBlobStore implements BlobStore {
    readonly id = 'local';

    private resolve(key: string): string {
        const segs = key.split('/');
        if (segs.some((s) => s === '' || s === '.' || s === '..')) {
            throw new Error(`blob key 含非法路径段: ${JSON.stringify(key)}`);
        }
        return join(getDataDir(), ...segs);
    }

    async put(key: string, data: Buffer): Promise<void> {
        const path = this.resolve(key);
        await mkdir(dirname(path), { recursive: true });
        // 原子写（H1 先例）：tmp 随机短名 + 同目录 rename；并发写同 key = 原子 last-wins
        const tmp = join(dirname(path), `.tmp.${randomBytes(6).toString('hex')}`);
        try {
            await fsWrite(tmp, data);
            await rename(tmp, path);
        } catch (e) {
            try { await unlink(tmp); } catch { /* 已不在 */ }
            throw e;
        }
    }

    async get(key: string): Promise<Buffer> {
        try {
            return await readFile(this.resolve(key));
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectNotFoundError(key);
            throw e;
        }
    }

    async head(key: string): Promise<{ size: number }> {
        try {
            const s = await stat(this.resolve(key));
            return { size: s.size };
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectNotFoundError(key);
            throw e;
        }
    }

    async getRange(key: string, start: number, end: number): Promise<Buffer> {
        const path = this.resolve(key);
        const fh = await open(path, 'r').catch((e) => {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new ObjectNotFoundError(key);
            throw e;
        });
        try {
            const len = end - start + 1;
            const buf = Buffer.alloc(len);
            const { bytesRead } = await fh.read(buf, 0, len, start);
            return buf.subarray(0, bytesRead);
        } finally {
            await fh.close();
        }
    }

    async delete(key: string): Promise<void> {
        try {
            await unlink(this.resolve(key));
        } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // 幂等（GC 反查后才删，ENOENT=已删）
            throw e;
        }
    }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/blobstore-local.test.ts`
Expected: PASS（7 个用例）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/blobstore-local.ts apps/web/tests/blobstore-local.test.ts
git commit -m "feat(web): 图片支持——LocalBlobStore（内容寻址/原子写/getRange/幂等 delete，TDD）"
```

---

### Task 7: S3BlobStore 完整实现（presign 本地计算可测）

**Files:**
- Modify: `apps/web/src/lib/server/blobstore-s3.ts`
- Test: `apps/web/tests/blobstore-s3.test.ts`（新建）
- 依赖：`@aws-sdk/s3-request-presigner`（需安装）

- [ ] **Step 1: 安装依赖**

Run: `bun --filter remote-reader-web add @aws-sdk/s3-request-presigner`
Expected: 安装成功（与既有 @aws-sdk/client-s3 同族，无新依赖家族）

- [ ] **Step 2: 写失败测试（presign 是纯本地 HMAC 计算，不出网可测）**

```ts
import { describe, it, expect, vi } from 'vitest';
import { S3BlobStore } from '$server/blobstore-s3';

const CFG = {
    endpoint: 'https://s3.cn-north-1.qiniucs.com',
    region: 'cn-north-1',
    bucket: 'test-bucket',
    accessKeyId: 'AKtest',
    secretAccessKey: 'SKtest',
    forcePathStyle: true
};

describe('S3BlobStore presign（本地计算，无网络 IO）', () => {
    it('presign get 输出 SigV4 query 签名形状', async () => {
        const store = new S3BlobStore(CFG);
        const url = await store.presign!('get', 'images/u-1/abcd', 3600);
        expect(url).toContain('https://s3.cn-north-1.qiniucs.com/test-bucket/images/u-1/abcd?');
        expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
        expect(url).toContain('X-Amz-SignedHeaders=host');
        expect(url).toMatch(/X-Amz-Expires=3600/);
        expect(url).toMatch(/X-Amz-Signature=[0-9a-f]{64}/);
    });

    it('presign put 同形状；锁时间后同参数产出逐字节相同 URL（桶对齐的前提）', async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date('2026-09-21T08:00:00Z'));
        try {
            const store = new S3BlobStore(CFG);
            const a = await store.presign!('put', 'k', 600);
            const b = await store.presign!('put', 'k', 600);
            expect(a).toBe(b); // X-Amz-Date 锁定后签名确定性（不锁会跨秒 flaky）
        } finally {
            vi.useRealTimers();
        }
    });

    it('uploadUrlTtlSeconds 默认 600', () => {
        expect(new S3BlobStore(CFG).uploadUrlTtlSeconds).toBe(600);
    });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun run test apps/web/tests/blobstore-s3.test.ts`
Expected: FAIL（TODO Task 7 抛错）

- [ ] **Step 4: 实现（替换空壳；错误映射复用 object-store-s3 的 mapGetError）**

```ts
import {
    S3Client, PutObjectCommand, GetObjectCommand, HeadObjectCommand, DeleteObjectCommand
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { ObjectStoreConfig } from './object-store';
import { ObjectNotFoundError, ArchiveUnavailableError } from './object-store';
import { mapGetError } from './object-store-s3';
import type { BlobStore } from './blobstore';

// s3 插件（spec §8）：Buffer 语义 + head/getRange/presign。
// 与现有 S3ObjectStore（string 语义）并存——Phase 5 冷却收敛时迁移消费者后删除旧实现。
// ⚠️ 七牛部署注意（spec §14）：presign 的 Bucket 必须用「S3 空间名」（空间名全局不唯一时七牛自动生成，控制台查）。
export class S3BlobStore implements BlobStore {
    readonly id = 's3';
    readonly uploadUrlTtlSeconds = 600;
    private readonly client: S3Client;
    private readonly bucket: string;

    constructor(config: ObjectStoreConfig) {
        this.client = new S3Client({
            endpoint: config.endpoint,
            region: config.region,
            forcePathStyle: config.forcePathStyle,
            credentials: {
                accessKeyId: config.accessKeyId,
                secretAccessKey: config.secretAccessKey
            },
            // 同 S3ObjectStore 先例：挂起端点快速失败交给 503 语义
            requestHandler: new NodeHttpHandler({ requestTimeout: 5_000 }),
            maxAttempts: 2
        });
        this.bucket = config.bucket;
    }

    async put(key: string, data: Buffer, contentType?: string): Promise<void> {
        try {
            await this.client.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: data,
                ContentType: contentType ?? 'application/octet-stream'
            }));
        } catch (e) {
            throw new ArchiveUnavailableError(`blob put ${key} 失败`, { cause: e });
        }
    }

    async get(key: string): Promise<Buffer> {
        let body: { transformToByteArray(): Promise<Uint8Array> } | undefined;
        try {
            const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
            body = res.Body as { transformToByteArray(): Promise<Uint8Array> };
        } catch (e) {
            throw mapGetError(key, e);
        }
        if (!body) throw new ObjectNotFoundError(key);
        try {
            return Buffer.from(await body.transformToByteArray());
        } catch (e) {
            throw new ArchiveUnavailableError(`blob get ${key} body 失败`, { cause: e });
        }
    }

    async head(key: string): Promise<{ size: number; etag?: string }> {
        try {
            const res = await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
            return {
                size: res.ContentLength ?? 0,
                // S3 ETag 带引号（"abc..."），confirm 比对前须 strip——在此归一化
                etag: res.ETag ? res.ETag.replace(/^"|"$/g, '') : undefined
            };
        } catch (e) {
            throw mapGetError(key, e);
        }
    }

    async getRange(key: string, start: number, end: number): Promise<Buffer> {
        // Range 实现：走 GetObjectCommand + Range 头（S3 兼容网关普遍支持；七牛 OK）
        let body: { transformToByteArray(): Promise<Uint8Array> } | undefined;
        try {
            const res = await this.client.send(new GetObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Range: `bytes=${start}-${end}`
            }));
            body = res.Body as { transformToByteArray(): Promise<Uint8Array> };
        } catch (e) {
            throw mapGetError(key, e);
        }
        if (!body) throw new ObjectNotFoundError(key);
        return Buffer.from(await body.transformToByteArray());
    }

    async delete(key: string): Promise<void> {
        try {
            await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
        } catch (e) {
            throw new ArchiveUnavailableError(`blob delete ${key} 失败`, { cause: e });
        }
    }

    /** 纯本地 HMAC 计算（SigV4），无网络 IO——每次调用微秒级 */
    async presign(op: 'get' | 'put', key: string, ttlSeconds: number): Promise<string> {
        const cmd = op === 'get'
            ? new GetObjectCommand({ Bucket: this.bucket, Key: key })
            : new PutObjectCommand({ Bucket: this.bucket, Key: key });
        return getSignedUrl(this.client, cmd, { expiresIn: ttlSeconds });
    }
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run test apps/web/tests/blobstore-s3.test.ts`
Expected: PASS（3 个用例——全部本地计算，不出网）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/server/blobstore-s3.ts apps/web/tests/blobstore-s3.test.ts apps/web/package.json bun.lock
git commit -m "feat(web): 图片支持——S3BlobStore（Buffer/head/getRange/presign，ETag 归一化，TDD）"
```

---

### Task 8: startup-check 扩展（backend 选择校验 + BODY_SIZE_LIMIT 双下限）

**Files:**
- Modify: `apps/web/src/lib/server/startup-check.ts`
- Test: `apps/web/tests/startup-check.test.ts`（扩展）

- [ ] **Step 1: 写失败测试（追加到 startup-check.test.ts，遵守该文件现有的 env 保存/恢复模式）**

```ts
describe('图片支持启动校验', () => {
    it('IMAGE_STORE_BACKEND=s3 但 OBJECT_STORE_* 缺失 → fail-fast（全环境）', () => {
        process.env.IMAGE_STORE_BACKEND = 's3';
        for (const k of ['OBJECT_STORE_ENDPOINT', 'OBJECT_STORE_REGION', 'OBJECT_STORE_BUCKET',
            'OBJECT_STORE_ACCESS_KEY_ID', 'OBJECT_STORE_SECRET_ACCESS_KEY']) delete process.env[k];
        expect(() => validateStartupConfig()).toThrow(/IMAGE_STORE_BACKEND.*s3/);
        delete process.env.IMAGE_STORE_BACKEND;
    });

    it('生产：BODY_SIZE_LIMIT 须 ≥ max(文档×1.5, 图片×1.37×1.5)', () => {
        process.env.NODE_ENV = 'production';
        process.env.SESSION_SECRET = 'a'.repeat(48);
        process.env.INITIAL_INVITE_CODE = 'strong-code-1';
        process.env.BASE_URL = 'https://reader.example.top';
        process.env.ORIGIN = 'https://reader.example.top';
        process.env.BODY_SIZE_LIMIT = '8M';       // 8M < 10MB×1.37×1.5 ≈ 21.5MB → 须拒
        process.env.IMAGE_STORE_BACKEND = 'local'; // s3 校验不触发
        expect(() => validateStartupConfig()).toThrow(/MAX_IMAGE_BYTES/);
        process.env.BODY_SIZE_LIMIT = '24M';       // 24M ≥ 21.5MB → 过
        expect(() => validateStartupConfig()).not.toThrow();
        delete process.env.NODE_ENV;
        delete process.env.SESSION_SECRET; delete process.env.INITIAL_INVITE_CODE;
        delete process.env.BASE_URL; delete process.env.ORIGIN; delete process.env.BODY_SIZE_LIMIT;
    });
});
```

（`validateStartupConfig` 与各 env 的 save/restore 遵循该测试文件的现有 helper 约定——若文件已有 `withEnv` 之类工具，用它改写；核心断言不变）

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/startup-check.test.ts`
Expected: FAIL（新校验不存在：s3 缺配置不抛 / 8M 通过了旧校验）

- [ ] **Step 3: 实现（`validateStartupConfig` 的两处扩展）**

第一处——在 `const objectStore = parseObjectStoreEnv();` 之后、冷档 warn 块之前插入：

```ts
    // 图片支持（spec §12）：IMAGE_STORE_BACKEND=s3 需要 OBJECT_STORE_* 齐全——确定性配置错误，全环境 fail-fast
    if (process.env.IMAGE_STORE_BACKEND === 's3' && objectStore === null) {
        throw new Error('IMAGE_STORE_BACKEND=s3 需 OBJECT_STORE_* 五项配置齐全（endpoint/region/bucket/accessKeyId/secretAccessKey）');
    }
```

第二处——替换现有 BODY_SIZE_LIMIT 校验块（`const maxUpload = ...` 起）：

```ts
    // adapter-node BODY_SIZE_LIMIT 默认仅 512K：须覆盖文档 JSON 与图片 base64（×1.37）两类上限（spec §12 双下限取 max）
    const rawLimit = process.env.BODY_SIZE_LIMIT;
    const limit = parseBodySizeLimitBytes(rawLimit ?? '512K');
    const maxUpload = envInt('MAX_UPLOAD_BYTES', 5 * 1024 * 1024);
    const maxImage = envInt('MAX_IMAGE_BYTES', 10 * 1024 * 1024);
    const need = Math.max(maxUpload * 1.5, Math.ceil(maxImage * 1.37 * 1.5));
    if (!Number.isFinite(limit) || limit < need) {
        throw new Error(
            `BODY_SIZE_LIMIT "${rawLimit ?? '512K'}"(${limit}B) 须 ≥ max(MAX_UPLOAD_BYTES×1.5, MAX_IMAGE_BYTES×1.37×1.5)=${need}B——` +
                '否则超限上传会被 adapter 在路由前拦成 400/413，排障方向被带偏；如 5M 文档+10M 图片配 24M（25165824）'
        );
    }
```

- [ ] **Step 4: 更新被新校验打破的 2 个存量用例 + 同步 .env.example**

新双下限（need = max(5MB×1.5, 10MB×1.37×1.5) ≈ 21.5MB）会使两个现有"通过"用例翻转失败（已逐条排查 16 个存量用例，恰这两条受影响）：

1. `'prod 强配置通过'`：`BODY_SIZE_LIMIT: '8M'` → 改为 `'24M'`（25165824 ≥ 21548237）
2. `'prod BODY_SIZE_LIMIT 带单位后缀按 1024 进制解析（512K ≥ 1KB×1.5 通过）'`：该用例 `MAX_UPLOAD_BYTES: '1024'` 但 `MAX_IMAGE_BYTES` 未设默认 10MB → need 跳到 21.5MB → 补设 `MAX_IMAGE_BYTES: '1024'`（保持原意图：小上限下 512K 通过）

同时更新 `.env.example` 的 `BODY_SIZE_LIMIT` 行（当前推荐 8388608）：值改 `25165824`，注释改"须 ≥ max(MAX_UPLOAD_BYTES×1.5, MAX_IMAGE_BYTES×1.37×1.5)；5M 文档+10M 图片配 24M"。（8M 存量部署升级即 fail-fast 属 spec §12 有意行为、错误信息自解释；本机生产 /opt/remote-reader 亦在该群体，部署前先改 env。INSTALL.md 汇总表更新留在 Phase 5 文档批）

- [ ] **Step 5: 跑测试确认通过 + 全文件回归**

Run: `bun run test apps/web/tests/startup-check.test.ts`
Expected: PASS（新旧用例全绿）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/server/startup-check.ts apps/web/tests/startup-check.test.ts .env.example
git commit -m "feat(web): 图片支持——startup-check 扩展（s3 后端配置校验 + BODY_SIZE_LIMIT 双下限取 max）+ 存量用例与 .env.example 同步（TDD）"
```

---

### Task 9: 批次收尾——全量回归 + 类型检查

- [ ] **Step 1: 全量测试**

Run: `bun run test`
Expected: 全部 PASS（存量用例 + 本批新增 ~19 用例）

- [ ] **Step 2: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 errors

- [ ] **Step 3: 启动冒烟（dev 起服务，确认 ensureSchema 对存量库/新库都幂等）**

Run: `cd apps/web && timeout 20 bun run dev`（观察启动日志无 SQL 报错后 Ctrl-C；或跑一次现有 e2e-check.sh 的健康段）
Expected: 无 `no such table` / `duplicate column` / 索引冲突报错

- [ ] **Step 4: 最终 Commit（如有收尾改动）+ 汇报**

```bash
git status --short   # 确认无未提交文件
```

若一切干净，Phase 1 完成。**验收标准**：三源（schema.ts/SCHEMA_SQL/迁移 0008）一致守卫测试绿；local/s3 双插件可注册可路由；startup 校验生效；存量测试零回归。

---

## Self-Review 记录

1. **Spec 覆盖**：本批覆盖 spec §4.1（DDL/迁移/回填/索引）、§8（接口定义/注册表/两实现/溯源路由前提/uploadUrlTtl）、§12（IMAGE_STORE_BACKEND/MAX_IMAGE_BYTES/startup 校验双下限）。§8 的 presign `opts` 透传缝——**刻意不在本批实现**（YAGNI，无消费者；spec 同款裁定），Phase 2+ 的 confirm/init 实现 presign 调用时不带 opts。§8 的「tiering 注入收敛」「删除旧 ObjectStore」属 Phase 5。✓
2. **占位符扫描**：Task 5 的两个空壳类是任务间编译依赖（Task 6/7 立即替换为真实现，步骤内注明），非计划占位符。其余步骤均含完整代码/命令。✓
3. **类型一致性**：`BlobStore` 接口签名与 spec §8 一致（put/get/head?/getRange?/delete/presign?）；`LocalBlobStore.head` 返回 `{ size: number }`（结构子类型兼容 `{ size: number; etag?: string }` ✓）；`S3BlobStore.presign` 实现 3 参数（接口 4 参含可选 opts——少可选参数在 TS 中兼容 ✓）；错误类型复用 object-store.ts 的 `ObjectNotFoundError`/`ArchiveUnavailableError`（**注意：object-store.ts 顶部值导入 object-store-s3，并非 S3-free**——blobstore-local 引它会传递加载 aws-sdk；server 侧现状同链无正确性问题，加载略重，Phase 5 收敛时把错误类挪至叶子模块）。✓
4. **已知执行注意**：blobstore.ts 最终形态用静态 import（Task 5 Step 4 已裁定）；`getRange` 的 S3 Range 头在七牛的兼容性已列入 spec §14 实测清单（Phase 8 e2e 真机验证）。
