# 冷热分层归档（Cold/Hot Tiering）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 冷文档（默认 30 天未访问未更新）自动归档到 S3 兼容远端对象存储（七牛/R2/OSS 网关/MinIO 通接），本地只留元数据与热文档；冷文档可看（同步拉取+后台回热）、标题可搜；未配置对象存储的部署行为 100% 不变。

**Architecture:** 纯归档模式——`hot`（本地磁盘有内容/远端无对象）⇄ `cold`（远端有对象/本地无文件/FTS content 为空）两态互斥；归档顺序 `PUT → DB commit → unlink`、回热顺序 `GET → 写本地 → DB commit → DELETE 远端`，最坏情况只产生可清理孤儿、永不丢内容；单实例内按 docId 进程内异步互斥锁串行化归档/回热。`storage_tier` 列是内容位置的唯一事实源（`storage_path` 冷态保留，记录回热落地路径）。

**Tech Stack:** TypeScript · SvelteKit · Drizzle ORM + SQLite（better-sqlite3）· `@aws-sdk/client-s3`（S3 兼容协议）· vitest（node 运行时）

**上游 spec:** `docs/superpowers/specs/2026-09-04-cold-hot-tiering-design.md`（改动架构前必读）

---

## File Structure

| 文件 | 职责 | 动作 |
|---|---|---|
| `apps/web/src/lib/server/db/schema.ts` | documents 表声明加 3 列 | Modify |
| `apps/web/src/lib/server/db/index.ts` | SCHEMA_SQL 新列 + `ensureTierColumns` 守护式 ALTER | Modify |
| `apps/web/src/lib/server/db/migrations/` | drizzle 生成的迁移 SQL | Generate |
| `apps/web/src/lib/server/object-store.ts` | ObjectStore 接口/错误类型/objectKeyFor/env 解析/内存 fake | Create |
| `apps/web/src/lib/server/object-store-s3.ts` | S3 兼容实现（@aws-sdk/client-s3） | Create |
| `apps/web/src/lib/server/tiering.ts` | 冷判定/归档/回热/互斥锁/调度器 | Create |
| `apps/web/src/lib/server/documents.ts` | `readDocumentContent`/`touchDocument`；upload/rename/delete 冷态交互 | Modify |
| `apps/web/src/lib/server/env.ts` | `getColdTierAfterDays` | Modify |
| `apps/web/src/lib/server/startup-check.ts` | OBJECT_STORE_* 完整性校验（全环境） | Modify |
| `apps/web/src/hooks.server.ts` | 启动调度器 | Modify |
| `apps/web/src/routes/s/[token]/+page.server.ts` | 走 readDocumentContent + 404/503 语义 | Modify |
| `apps/web/src/routes/d/[id]/+page.server.ts` | 同上 | Modify |
| `apps/web/src/lib/server/search.ts` | 末段 SELECT 列别名（storageTier 供 UI） | Modify |
| `apps/web/src/routes/search/+page.svelte` | 冷文档「已归档」snippet 占位 | Modify |
| `apps/web/src/routes/+page.svelte` | 文件管理器冷文档 badge | Modify |
| `.env.example` | OBJECT_STORE_* + COLD_TIER_AFTER_DAYS | Modify |
| `CLAUDE.md` | 状态/环境变量指针 | Modify |
| `apps/web/tests/object-store.test.ts` | 新建 | Create |
| `apps/web/tests/tiering.test.ts` | 新建 | Create |
| `apps/web/tests/tiering-view.test.ts` | 新建 | Create |
| `apps/web/tests/tiering-search.test.ts` | 新建 | Create |
| `apps/web/tests/documents.test.ts` | 追加冷态交互用例 | Modify |
| `apps/web/tests/startup-check.test.ts` | 追加配置完整性用例 | Modify |

依赖关系：Task 1（schema）→ Task 2（object-store）→ Task 3（tiering）→ Task 4（读路径）→ Task 5（写路径）→ Task 6（搜索/UI）→ Task 7（启动/配置/文档）→ Task 8（回归）。

---

### Task 1: Schema 三列变更（运行时建表 / drizzle 声明 / 迁移三处一致）

**Files:**
- Modify: `apps/web/src/lib/server/db/schema.ts`
- Modify: `apps/web/src/lib/server/db/index.ts`
- Generate: `apps/web/src/lib/server/db/migrations/`
- Test: `apps/web/tests/tiering-schema.test.ts`（新建）

- [ ] **Step 1.1: 写失败测试**

创建 `apps/web/tests/tiering-schema.test.ts`：

```ts
import { test, expect } from 'vitest';
import Database from 'better-sqlite3';
import { ensureTierColumns, sqlite } from '../src/lib/server/db';

const OLD_DOCUMENTS_SQL = `CREATE TABLE documents (
    id text PRIMARY KEY NOT NULL,
    owner_id text NOT NULL,
    parent_id text,
    name text NOT NULL,
    type text NOT NULL,
    storage_path text,
    content_hash text,
    size_bytes integer,
    created_at integer NOT NULL,
    updated_at integer NOT NULL
)`;

test('主库 documents 表含分层三列', () => {
    const cols = sqlite.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('storage_tier');
    expect(names).toContain('last_viewed_at');
    expect(names).toContain('archived_at');
});

test('旧库经 ensureTierColumns 升级出三列且幂等，存量行默认 hot', () => {
    const raw = new Database(':memory:');
    raw.exec(OLD_DOCUMENTS_SQL);
    ensureTierColumns(raw);
    ensureTierColumns(raw);
    const cols = raw.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    const names = cols.map((c) => c.name);
    expect(names).toContain('storage_tier');
    expect(names).toContain('last_viewed_at');
    expect(names).toContain('archived_at');
    raw.exec(`INSERT INTO documents (id, owner_id, name, type, created_at, updated_at)
              VALUES ('d1', 'u1', 'a.md', 'file', 1, 1)`);
    const row = raw.prepare('SELECT storage_tier FROM documents WHERE id = ?').get('d1') as { storage_tier: string };
    expect(row.storage_tier).toBe('hot');
});
```

- [ ] **Step 1.2: 运行确认失败**

Run: `bun run test apps/web/tests/tiering-schema.test.ts`
Expected: FAIL（`ensureTierColumns` 未导出 / 主库无 `storage_tier` 列）

- [ ] **Step 1.3: 修改 schema.ts**

`documents` 表定义中 `updatedAt` 之后追加：

```ts
    storageTier: text('storage_tier', { enum: ['hot', 'cold'] }).notNull().default('hot'),
    lastViewedAt: integer('last_viewed_at'),
    archivedAt: integer('archived_at')
```

- [ ] **Step 1.4: 修改 db/index.ts（两处）**

4a. `SCHEMA_SQL` 内 `CREATE TABLE IF NOT EXISTS documents` 的 `updated_at integer NOT NULL,` 之后追加三列（全新部署走此路径）：

```sql
    storage_tier text NOT NULL DEFAULT 'hot',
    last_viewed_at integer,
    archived_at integer,
```

4b. `ensureSchema` 前新增导出函数，并在 `ensureSchema()` 内 `sqlite.exec(SCHEMA_SQL);` 之后调用 `ensureTierColumns(sqlite);`（存量部署升级路径——SQLite 不支持 `ADD COLUMN IF NOT EXISTS`，用 PRAGMA 守护）：

```ts
import type { Database as SqliteDb } from 'better-sqlite3';

// 冷热分层三列：存量库升级（CREATE TABLE IF NOT EXISTS 对已存在的表是 no-op）
export function ensureTierColumns(target: SqliteDb): void {
    const cols = target.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
    const names = new Set(cols.map((c) => c.name));
    if (!names.has('storage_tier')) {
        target.exec("ALTER TABLE documents ADD COLUMN storage_tier text NOT NULL DEFAULT 'hot'");
    }
    if (!names.has('last_viewed_at')) {
        target.exec('ALTER TABLE documents ADD COLUMN last_viewed_at integer');
    }
    if (!names.has('archived_at')) {
        target.exec('ALTER TABLE documents ADD COLUMN archived_at integer');
    }
}
```

- [ ] **Step 1.5: 生成 drizzle 迁移**

Run: `bun --filter remote-reader-web db:generate`
Expected: `apps/web/src/lib/server/db/migrations/` 出现新迁移文件，内含 3 条 `ALTER TABLE documents ADD COLUMN ...`（`storage_tier text NOT NULL DEFAULT 'hot'` / `last_viewed_at integer` / `archived_at integer`）。人工打开核对该文件内容与上表一致。

- [ ] **Step 1.6: 运行测试确认通过**

Run: `bun run test apps/web/tests/tiering-schema.test.ts`
Expected: PASS ×2

- [ ] **Step 1.7: 全量回归（现有测试零改动必须全过——向后兼容证明第一道门）**

Run: `bun run test`
Expected: 全部 PASS（现有用例对 `db.insert(documents)` 的 raw SQL 插入因 `DEFAULT 'hot'` 不受影响）

- [ ] **Step 1.8: Commit**

```bash
git add apps/web/src/lib/server/db apps/web/tests/tiering-schema.test.ts
git commit -m "feat(web): 冷热分层 schema——documents 加 storage_tier/last_viewed_at/archived_at 三列（存量库守护式升级）"
```

---

### Task 2: ObjectStore 统一抽象层（接口/错误/key/env 解析/内存 fake/S3 实现）

**Files:**
- Create: `apps/web/src/lib/server/object-store.ts`
- Create: `apps/web/src/lib/server/object-store-s3.ts`
- Test: `apps/web/tests/object-store.test.ts`

- [ ] **Step 2.1: 安装依赖**

Run（workdir `apps/web`）: `bun add @aws-sdk/client-s3 @smithy/node-http-handler`
Expected: `apps/web/package.json` dependencies 出现 `"@aws-sdk/client-s3"` 与 `"@smithy/node-http-handler"`（后者供请求超时配置，见 Step 2.5 执行修正）

- [ ] **Step 2.2: 写失败测试**

创建 `apps/web/tests/object-store.test.ts`：

```ts
import { test, expect, afterEach } from 'vitest';
import {
    parseObjectStoreEnv, objectKeyFor, MemoryObjectStore,
    ObjectNotFoundError, ArchiveUnavailableError, getObjectStore, __setObjectStoreForTest
} from '../src/lib/server/object-store';
import { S3ObjectStore, mapGetError } from '../src/lib/server/object-store-s3';

const ORIG: NodeJS.ProcessEnv = { ...process.env };
afterEach(() => {
    for (const k of Object.keys(process.env)) {
        if (!(k in ORIG)) delete process.env[k];
    }
    Object.assign(process.env, ORIG);
    __setObjectStoreForTest(undefined);
});

test('OBJECT_STORE_* 全空 → null（功能关闭）', () => {
    expect(parseObjectStoreEnv({} as NodeJS.ProcessEnv)).toBeNull();
});

test('部分配置 → 抛错并列出缺失变量名', () => {
    expect(() => parseObjectStoreEnv({ OBJECT_STORE_BUCKET: 'b' } as NodeJS.ProcessEnv))
        .toThrow(/OBJECT_STORE_ENDPOINT|不完整/);
});

test('完整配置 → 返回配置对象，forcePathStyle 默认 false / "true" 开启', () => {
    const full = {
        OBJECT_STORE_ENDPOINT: 'https://s3.cn-east-1.qiniucs.com',
        OBJECT_STORE_REGION: 'cn-east-1',
        OBJECT_STORE_BUCKET: 'b',
        OBJECT_STORE_ACCESS_KEY_ID: 'ak',
        OBJECT_STORE_SECRET_ACCESS_KEY: 'sk'
    } as NodeJS.ProcessEnv;
    const cfg = parseObjectStoreEnv(full);
    expect(cfg).toMatchObject({ bucket: 'b', region: 'cn-east-1', forcePathStyle: false });
    expect(parseObjectStoreEnv({ ...full, OBJECT_STORE_FORCE_PATH_STYLE: 'true' } as NodeJS.ProcessEnv)?.forcePathStyle).toBe(true);
});

test('objectKeyFor：archive/<ownerId>/<docId>-<hash>.md；null hash 有保底', () => {
    expect(objectKeyFor({ ownerId: 'o1', id: 'd1', contentHash: 'abc' })).toBe('archive/o1/d1-abc.md');
    expect(objectKeyFor({ ownerId: 'o1', id: 'd1', contentHash: null })).toBe('archive/o1/d1-nohash.md');
});

test('MemoryObjectStore：put/get/delete 往返；缺失 get → ObjectNotFoundError；失败注入 → ArchiveUnavailableError', async () => {
    const s = new MemoryObjectStore();
    await s.put('k', 'v');
    expect(await s.get('k')).toBe('v');
    await expect(s.get('nope')).rejects.toBeInstanceOf(ObjectNotFoundError);
    s.failPut = true;
    await expect(s.put('k2', 'v2')).rejects.toBeInstanceOf(ArchiveUnavailableError);
    s.failPut = false;
    await s.delete('k');
    await expect(s.get('k')).rejects.toBeInstanceOf(ObjectNotFoundError);
});

test('getObjectStore 未配置 → null 且可被测试覆写', () => {
    expect(getObjectStore()).toBeNull();
    const fake = new MemoryObjectStore();
    __setObjectStoreForTest(fake);
    expect(getObjectStore()).toBe(fake);
});

test('mapGetError：NoSuchKey → ObjectNotFoundError，其余 → ArchiveUnavailableError', () => {
    expect(mapGetError('k', { name: 'NoSuchKey' })).toBeInstanceOf(ObjectNotFoundError);
    expect(mapGetError('k', new Error('network'))).toBeInstanceOf(ArchiveUnavailableError);
    expect(mapGetError('k', {})).toBeInstanceOf(ArchiveUnavailableError);
});
```

- [ ] **Step 2.3: 运行确认失败**

Run: `bun run test apps/web/tests/object-store.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 2.4: 实现 object-store.ts**

创建 `apps/web/src/lib/server/object-store.ts`：

```ts
import { S3ObjectStore } from './object-store-s3';

export interface ObjectStore {
    put(key: string, content: string): Promise<void>;
    get(key: string): Promise<string>;
    delete(key: string): Promise<void>;
}

// 远端对象缺失（语义对齐 storage.ts 的 FileNotFoundError → 路由层 404）
export class ObjectNotFoundError extends Error {
    readonly code = 'ARCHIVE_OBJECT_NOT_FOUND' as const;
    constructor(key: string) {
        super(`archived object not found: ${key}`);
        this.name = 'ObjectNotFoundError';
    }
}

// 远端不可达/未配置（路由层 → 503）
export class ArchiveUnavailableError extends Error {
    readonly code = 'ARCHIVE_UNAVAILABLE' as const;
    constructor(message: string, options?: { cause: unknown }) {
        super(message);
        this.name = 'ArchiveUnavailableError';
        if (options && 'cause' in options) this.cause = options.cause;
    }
}

// 对象 key：docId 维度（删除无引用计数）+ contentHash 后缀（覆盖上传换 key、同内容重传幂等）
export function objectKeyFor(doc: { ownerId: string; id: string; contentHash: string | null }): string {
    return `archive/${doc.ownerId}/${doc.id}-${doc.contentHash ?? 'nohash'}.md`;
}

export type ObjectStoreConfig = {
    endpoint: string;
    region: string;
    bucket: string;
    accessKeyId: string;
    secretAccessKey: string;
    forcePathStyle: boolean;
};

const ENV_KEYS = [
    'OBJECT_STORE_ENDPOINT',
    'OBJECT_STORE_REGION',
    'OBJECT_STORE_BUCKET',
    'OBJECT_STORE_ACCESS_KEY_ID',
    'OBJECT_STORE_SECRET_ACCESS_KEY'
] as const;

// 全部留空 → null（分层关闭）；任一已配置但组合不完整 → 抛错（确定性配置错误，fail-fast）
export function parseObjectStoreEnv(env: NodeJS.ProcessEnv = process.env): ObjectStoreConfig | null {
    const vals: Record<string, string | undefined> = {};
    for (const k of ENV_KEYS) vals[k] = env[k];
    const anySet = Object.values(vals).some((v) => v !== undefined && v !== '');
    if (!anySet) return null;
    const missing = Object.entries(vals).filter(([, v]) => !v).map(([k]) => k);
    if (missing.length > 0) {
        throw new Error(
            `对象存储配置不完整：已设置部分 OBJECT_STORE_* 变量但缺少 ${missing.join(', ')}（要么全部留空关闭分层，要么全部提供）`
        );
    }
    return {
        endpoint: vals.OBJECT_STORE_ENDPOINT!,
        region: vals.OBJECT_STORE_REGION!,
        bucket: vals.OBJECT_STORE_BUCKET!,
        accessKeyId: vals.OBJECT_STORE_ACCESS_KEY_ID!,
        secretAccessKey: vals.OBJECT_STORE_SECRET_ACCESS_KEY!,
        forcePathStyle: env.OBJECT_STORE_FORCE_PATH_STYLE === 'true'
    };
}

let cached: ObjectStore | null | undefined;

export function getObjectStore(): ObjectStore | null {
    if (cached === undefined) {
        const config = parseObjectStoreEnv();
        cached = config === null ? null : new S3ObjectStore(config);
    }
    return cached;
}

// 仅供测试：覆写/重置单例
export function __setObjectStoreForTest(store: ObjectStore | null | undefined): void {
    cached = store;
}

// 测试 fake：内存实现 + 失败注入（崩溃窗口测试用）
export class MemoryObjectStore implements ObjectStore {
    readonly data = new Map<string, string>();
    failPut = false;
    failGet = false;
    failDelete = false;
    async put(key: string, content: string): Promise<void> {
        if (this.failPut) throw new ArchiveUnavailableError(`put ${key} 失败（测试注入）`);
        this.data.set(key, content);
    }
    async get(key: string): Promise<string> {
        if (this.failGet) throw new ArchiveUnavailableError(`get ${key} 失败（测试注入）`);
        const v = this.data.get(key);
        if (v === undefined) throw new ObjectNotFoundError(key);
        return v;
    }
    async delete(key: string): Promise<void> {
        if (this.failDelete) throw new ArchiveUnavailableError(`delete ${key} 失败（测试注入）`);
        this.data.delete(key);
    }
}
```

- [ ] **Step 2.5: 实现 object-store-s3.ts**

创建 `apps/web/src/lib/server/object-store-s3.ts`：

```ts
import { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { NodeHttpHandler } from '@smithy/node-http-handler';
import type { ObjectStore, ObjectStoreConfig } from './object-store';
import { ObjectNotFoundError, ArchiveUnavailableError } from './object-store';

// GET 错误映射：NoSuchKey → 对象缺失（404 语义）；其余 → 不可达（503 语义）
export function mapGetError(key: string, e: unknown): Error {
    if ((e as { name?: string }).name === 'NoSuchKey') return new ObjectNotFoundError(key);
    return new ArchiveUnavailableError(`get ${key} 失败`, { cause: e });
}

export class S3ObjectStore implements ObjectStore {
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
            // SDK 默认无请求超时：挂起端点会拖死冷读请求与文档锁，快速失败交给 503 语义（spec §5）
            // 执行修正：requestTimeout 非 S3ClientConfig 合法键（SDK v3 须走 requestHandler）
            requestHandler: new NodeHttpHandler({ requestTimeout: 5_000 }),
            maxAttempts: 2
        });
        this.bucket = config.bucket;
    }

    async put(key: string, content: string): Promise<void> {
        try {
            await this.client.send(new PutObjectCommand({
                Bucket: this.bucket,
                Key: key,
                Body: content,
                ContentType: 'text/markdown; charset=utf-8'
            }));
        } catch (e) {
            throw new ArchiveUnavailableError(`put ${key} 失败`, { cause: e });
        }
    }

    async get(key: string): Promise<string> {
        let body: { transformToString(encoding: string): Promise<string> } | undefined;
        try {
            const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
            body = res.Body;
        } catch (e) {
            throw mapGetError(key, e);
        }
        if (!body) throw new ObjectNotFoundError(key);
        return body.transformToString('utf-8');
    }

    async delete(key: string): Promise<void> {
        try {
            await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
        } catch (e) {
            throw new ArchiveUnavailableError(`delete ${key} 失败`, { cause: e });
        }
    }
}
```

- [ ] **Step 2.6: 运行测试确认通过**

Run: `bun run test apps/web/tests/object-store.test.ts`
Expected: PASS ×7

- [ ] **Step 2.7: Commit**

```bash
git add apps/web/package.json bun.lock apps/web/src/lib/server/object-store.ts apps/web/src/lib/server/object-store-s3.ts apps/web/tests/object-store.test.ts
git commit -m "feat(web): ObjectStore 统一抽象——S3 兼容实现（通接七牛/R2/OSS/MinIO）+ env 解析 + 内存 fake"
```

---

### Task 3: 归档/回热引擎（冷判定 + 状态机 + 互斥锁 + 调度器）

**Files:**
- Create: `apps/web/src/lib/server/tiering.ts`
- Modify: `apps/web/src/lib/server/env.ts`
- Test: `apps/web/tests/tiering.test.ts`

- [ ] **Step 3.1: env.ts 加阈值读取**

`apps/web/src/lib/server/env.ts` 末尾追加：

```ts
export function getColdTierAfterDays(): number {
    return envInt('COLD_TIER_AFTER_DAYS', 30);
}
```

- [ ] **Step 3.2: 写失败测试**

创建 `apps/web/tests/tiering.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync, existsSync } from 'node:fs';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId, sha256Hex } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';
import { isColdCandidate, runArchiveCycle, rewarmDocument, withDocLock } from '../src/lib/server/tiering';
import { MemoryObjectStore, __setObjectStoreForTest, objectKeyFor } from '../src/lib/server/object-store';
import { eq } from 'drizzle-orm';

const DAY = 86_400_000;
let ownerId: string;
let store: MemoryObjectStore;
const TMP_DOCS = `./data/test-tiering-${Date.now().toString(36)}`;

function getDoc(id: string) {
    return db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!;
}

beforeEach(async () => {
    process.env.DATA_DIR = TMP_DOCS;
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId, email: `t-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    store = new MemoryObjectStore();
    __setObjectStoreForTest(store);
});

afterEach(() => {
    try { rmSync(TMP_DOCS, { recursive: true, force: true }); } catch {}
    __setObjectStoreForTest(undefined);
});

// 冷态夹具：上传 → 把 updated_at 回拨 40 天 → 跑一轮归档
async function makeCold(content: string, name = 'd.md'): Promise<string> {
    const r = await uploadDocument(ownerId, name, content, []);
    db.update(schema.documents)
        .set({ updatedAt: Date.now() - 40 * DAY })
        .where(eq(schema.documents.id, r.id)).run();
    await runArchiveCycle(store);
    expect(getDoc(r.id).storageTier).toBe('cold');
    return r.id;
}

test('isColdCandidate：file+hot+超阈值；folder/cold/无盘路径/新文档不冷', () => {
    const now = Date.now();
    const base = { type: 'file', storageTier: 'hot', storagePath: '/x', createdAt: now, updatedAt: now - 40 * DAY, lastViewedAt: null };
    expect(isColdCandidate(base, now, 30)).toBe(true);
    expect(isColdCandidate({ ...base, updatedAt: now - 29 * DAY }, now, 30)).toBe(false);
    expect(isColdCandidate({ ...base, type: 'folder' }, now, 30)).toBe(false);
    expect(isColdCandidate({ ...base, storageTier: 'cold' }, now, 30)).toBe(false);
    expect(isColdCandidate({ ...base, storagePath: null }, now, 30)).toBe(false);
    // last_viewed_at 晚于 updated_at → 以 last_viewed_at 判定（看过就推迟冷却）
    expect(isColdCandidate({ ...base, lastViewedAt: now - 5 * DAY }, now, 30)).toBe(false);
    // last_viewed_at 为 null 回退 created_at
    expect(isColdCandidate({ ...base, updatedAt: now, createdAt: now - 40 * DAY }, now, 30)).toBe(true);
});

test('归档全流程：PUT 对象 → DB 标 cold + FTS 清 content → 删本地', async () => {
    const r = await uploadDocument(ownerId, 'a.md', '# hello archive-me', []);
    const row = getDoc(r.id);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    const n = await runArchiveCycle(store);
    expect(n).toBe(1);
    const after = getDoc(r.id);
    expect(after.storageTier).toBe('cold');
    expect(after.archivedAt).toBeGreaterThan(0);
    expect(existsSync(row.storagePath!)).toBe(false);
    const key = objectKeyFor(after);
    expect(store.data.get(key)).toBe('# hello archive-me');
    const fts = sqlite.prepare('SELECT content FROM docs_fts WHERE doc_id = ?').get(r.id) as { content: string };
    expect(fts.content).toBe('');
    // storage_path 保留（回热落地路径）
    expect(after.storagePath).toBe(row.storagePath);
});

test('hash 不一致（盘内容被篡改）→ 跳过归档，保持 hot', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'v1', []);
    const row = getDoc(r.id);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    const { writeFile } = await import('../src/lib/server/storage');
    await writeFile(row.storagePath!, 'tampered'); // 磁盘内容 ≠ DB hash
    const n = await runArchiveCycle(store);
    expect(n).toBe(0);
    expect(getDoc(r.id).storageTier).toBe('hot');
    expect(store.data.size).toBe(0);
});

test('本地文件缺失 → 跳过归档（不造出"两边皆空"）', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'v1', []);
    const row = getDoc(r.id);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    const { unlink } = await import('node:fs/promises');
    await unlink(row.storagePath!);
    expect(await runArchiveCycle(store)).toBe(0);
    expect(getDoc(r.id).storageTier).toBe('hot');
});

test('崩溃窗口：PUT 失败 → 保持 hot、本地完好、FTS 完整（数据无损）', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'keep me', []);
    const row = getDoc(r.id);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    store.failPut = true;
    expect(await runArchiveCycle(store)).toBe(0); // 单文档失败被 cycle 捕获隔离，计数 0
    store.failPut = false;
    expect(getDoc(r.id).storageTier).toBe('hot');
    expect(existsSync(row.storagePath!)).toBe(true);
});

test('回热：GET → 写本地 → DB 标 hot + FTS 恢复 → 删远端', async () => {
    const id = await makeCold('# rewarm me');
    const row = getDoc(id);
    await rewarmDocument(id, '# rewarm me');
    const after = getDoc(id);
    expect(after.storageTier).toBe('hot');
    expect(after.lastViewedAt).toBeGreaterThan(0);
    expect(after.archivedAt).toBeNull();
    expect(existsSync(after.storagePath!)).toBe(true);
    const { readFile } = await import('../src/lib/server/storage');
    expect(await readFile(after.storagePath!)).toBe('# rewarm me');
    expect(store.data.has(objectKeyFor(row))).toBe(false);
    const fts = sqlite.prepare('SELECT content FROM docs_fts WHERE doc_id = ?').get(id) as { content: string };
    expect(fts.content).toBe('# rewarm me');
});

test('回热崩溃窗口：删远端失败 → hot + 远端孤儿（无害，不丢内容）', async () => {
    const id = await makeCold('# x');
    store.failDelete = true;
    await rewarmDocument(id, '# x');
    expect(getDoc(id).storageTier).toBe('hot');
    expect(store.data.size).toBe(1); // 孤儿对象仍在
    store.failDelete = false;
});

test('withDocLock 串行化同 docId 操作', async () => {
    const order: number[] = [];
    const slow = withDocLock('d', async () => {
        await new Promise((r) => setTimeout(r, 30));
        order.push(1);
    });
    await withDocLock('d', async () => { order.push(2); });
    await slow;
    expect(order).toEqual([1, 2]);
});

test('批量上限 50：60 个候选单轮只归档 50，下一轮清尾', async () => {
    for (let i = 0; i < 60; i++) {
        const r = await uploadDocument(ownerId, `f${i}.md`, `c${i}`, []);
        db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    }
    expect(await runArchiveCycle(store)).toBe(50);
    expect(await runArchiveCycle(store)).toBe(10);
});

// ── 竞态回归（spec §4.2，双 Agent 交叉审查发现，用 gate 注入交错）──
class GatedMemoryStore extends MemoryObjectStore {
    gate: Promise<void> = Promise.resolve();
    async put(key: string, content: string): Promise<void> {
        await this.gate;
        return super.put(key, content);
    }
    async get(key: string): Promise<string> {
        await this.gate;
        return super.get(key);
    }
}

test('竞态：归档 PUT 窗口内覆盖上传 → doc 锁串行化，v2 完好不丢（P0 回归）', async () => {
    const gated = new GatedMemoryStore();
    __setObjectStoreForTest(gated);
    const r = await uploadDocument(ownerId, 'a.md', 'v1', []);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    let release!: () => void;
    gated.gate = new Promise((res) => { release = res; });
    const cycle = runArchiveCycle(gated);                       // 卡在 PUT
    await new Promise((res) => setTimeout(res, 30));            // 等 PUT 到达 gate
    // 注意：上传只发起不 await——它会阻塞在被 gate 卡住的 doc 锁上，先 await 会死锁（永远到不了 release）
    const upload = uploadDocument(ownerId, 'a.md', 'v2', []);   // PUT 窗口内到达，被 doc 锁挡住
    await new Promise((res) => setTimeout(res, 30));            // 等上传抵达锁队列
    release!();                                                 // 归档完成 → 锁释放 → 上传继续
    await cycle;
    await upload;
    const row = getDoc(r.id);
    expect(row.storageTier).toBe('hot');
    expect(row.contentHash).toBe(sha256Hex('v2'));
    const { readFile } = await import('../src/lib/server/storage');
    expect(await readFile(row.storagePath!)).toBe('v2');
    const fts = sqlite.prepare('SELECT content FROM docs_fts WHERE doc_id = ?').get(r.id) as { content: string };
    expect(fts.content).toBe('v2');
    expect(gated.data.size).toBe(0);                            // 旧 v1 对象被覆盖上传清理
});

test('竞态：回热 GET 窗口内覆盖上传 → FTS 不倒退、终态 v2 一致（P1 回归）', async () => {
    const gated = new GatedMemoryStore();
    __setObjectStoreForTest(gated);
    const r = await uploadDocument(ownerId, 'a.md', 'v1', []);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    await runArchiveCycle(gated);                                // v1 落远端，tier=cold
    let release!: () => void;
    gated.gate = new Promise((res) => { release = res; });
    const rewarm = rewarmDocument(r.id);                         // 无 content → GET 卡 gate
    await new Promise((res) => setTimeout(res, 30));
    const upload = uploadDocument(ownerId, 'a.md', 'v2', []);    // GET 窗口内到达，被 doc 锁挡住（同样只发起不 await，防死锁）
    await new Promise((res) => setTimeout(res, 30));
    release!();                                                  // 回热完成 → 锁释放 → 上传继续
    await rewarm;
    await upload;
    const row = getDoc(r.id);
    expect(row.storageTier).toBe('hot');
    expect(row.contentHash).toBe(sha256Hex('v2'));
    const { readFile } = await import('../src/lib/server/storage');
    expect(await readFile(row.storagePath!)).toBe('v2');
    const fts = sqlite.prepare('SELECT content FROM docs_fts WHERE doc_id = ?').get(r.id) as { content: string };
    expect(fts.content).toBe('v2');                              // 索引不倒退回 v1
    expect(gated.data.size).toBe(0);
});
```

- [ ] **Step 3.3: 运行确认失败**

Run: `bun run test apps/web/tests/tiering.test.ts`
Expected: FAIL（`../src/lib/server/tiering` 不存在）

- [ ] **Step 3.4: 实现 tiering.ts**

创建 `apps/web/src/lib/server/tiering.ts`：

```ts
import { eq, and } from 'drizzle-orm';
import { unlink } from 'node:fs/promises';
import { db, sqlite, schema } from './db';
import { sha256Hex } from './auth';
import { readFile, writeFile } from './storage';
import { getObjectStore, objectKeyFor } from './object-store';
import type { ObjectStore } from './object-store';
import { getColdTierAfterDays } from './env';

type DocumentRow = typeof schema.documents.$inferSelect;

export const ARCHIVE_BATCH_LIMIT = 50;
export const TIERING_INTERVAL_MS = 3_600_000; // 1 小时

// ── 冷判定（纯函数）────────────────────────────────────────────
// 冷 = N 天内既没人看（last_viewed_at ?? created_at）也没更新（updated_at）
export function isColdCandidate(
    row: {
        type: string;
        storageTier: string;
        storagePath: string | null;
        createdAt: number;
        updatedAt: number;
        lastViewedAt: number | null;
    },
    nowMs: number,
    thresholdDays: number
): boolean {
    if (row.type !== 'file') return false;
    if (row.storageTier !== 'hot') return false;
    if (!row.storagePath) return false;
    const lastActivity = Math.max(row.lastViewedAt ?? row.createdAt, row.updatedAt);
    return nowMs - lastActivity > thresholdDays * 86_400_000;
}

// ── 按 docId 的进程内互斥锁（单实例部署：归档/回热同进程，串行化防竞态丢内容，spec §4.2）
const docLocks = new Map<string, Promise<unknown>>();

export function withDocLock<T>(docId: string, fn: () => Promise<T>): Promise<T> {
    const prev = docLocks.get(docId) ?? Promise.resolve();
    const next = prev.catch(() => {}).then(fn);
    docLocks.set(docId, next);
    void next
        .catch(() => {})
        .finally(() => {
            if (docLocks.get(docId) === next) docLocks.delete(docId);
        });
    return next;
}

// ── 归档：PUT → DB commit（cold + FTS 清 content）→ unlink ─────
// 顺序保证：任何崩溃点最坏只留孤儿（远端对象/本地文件），内容永不丢（spec §4.1）
async function archiveDocument(doc: DocumentRow, store: ObjectStore, days: number): Promise<'archived' | 'skipped'> {
    return withDocLock(doc.id, async () => {
        const fresh = db.select().from(schema.documents).where(eq(schema.documents.id, doc.id)).get();
        if (!fresh || fresh.type !== 'file' || fresh.storageTier !== 'hot' || !fresh.storagePath) {
            return 'skipped';
        }
        // 锁内复查冷判定：扫描快照到锁内执行期间可能刚被访问，刚看过的不归档（spec §6）
        if (!isColdCandidate(fresh, Date.now(), days)) return 'skipped';
        let content: string;
        try {
            content = await readFile(fresh.storagePath);
        } catch (e) {
            console.warn('[tiering] 本地文件不可读，跳过归档（保持 hot 不造"两边皆空"）', fresh.id, e);
            return 'skipped';
        }
        // 完整性防线：盘内容与 DB hash 不一致（损坏/篡改）绝不归档
        if (sha256Hex(content) !== fresh.contentHash) {
            console.warn('[tiering] 内容 hash 与 DB 不一致，跳过归档', fresh.id);
            return 'skipped';
        }
        await store.put(objectKeyFor(fresh), content);
        let flipped = false;
        db.transaction((tx) => {
            tx.update(schema.documents)
                .set({ storageTier: 'cold', archivedAt: Date.now() })
                .where(and(eq(schema.documents.id, fresh.id), eq(schema.documents.storageTier, 'hot')))
                .run();
            // §4.2 状态翻转验证：未翻转（被不可上锁的同步路径如 deleteNode 改变状态）则跳过 FTS 清空
            flipped = (sqlite.prepare('SELECT changes() AS n').get() as { n: number }).n > 0;
            if (flipped) sqlite.prepare("UPDATE docs_fts SET content = '' WHERE doc_id = ?").run(fresh.id);
        });
        if (!flipped) {
            // 未翻转：刚 PUT 的对象成孤儿，best-effort 清理（失败留孤儿，无害，spec §4.1）
            try { await store.delete(objectKeyFor(fresh)); } catch { /* 留孤儿，无害 */ }
            return 'skipped';
        }
        try {
            await unlink(fresh.storagePath);
        } catch (e) {
            console.warn('[tiering] 归档后删本地失败（孤儿文件，无害）', fresh.storagePath, e);
        }
        return 'archived';
    });
}

// ── 回热：GET → 写本地 → DB commit（hot + FTS 恢复）→ DELETE 远端 ──
export async function rewarmDocument(docId: string, content?: string): Promise<void> {
    return withDocLock(docId, async () => {
        const row = db.select().from(schema.documents).where(eq(schema.documents.id, docId)).get();
        if (!row || row.storageTier !== 'cold') return;
        const store = getObjectStore();
        if (!store) {
            console.warn('[tiering] 对象存储未配置，无法回热', docId);
            return;
        }
        let body = content;
        if (body === undefined) body = await store.get(objectKeyFor(row));
        if (!row.storagePath) {
            console.warn('[tiering] 冷文档缺 storagePath，无法回热', docId);
            return;
        }
        await writeFile(row.storagePath, body);
        let flipped = false;
        db.transaction((tx) => {
            tx.update(schema.documents)
                .set({ storageTier: 'hot', lastViewedAt: Date.now(), archivedAt: null })
                .where(and(eq(schema.documents.id, docId), eq(schema.documents.storageTier, 'cold')))
                .run();
            // §4.2 状态翻转验证 + FTS 与 tier 翻转同事务（deleteNode 相同模式）：
            // 未翻转（被同步 deleteNode 删行等）则跳过 FTS 恢复，防孤儿 FTS 行与索引倒退；
            // 覆盖上传与回热的交错已由 doc 锁串行化，此处防御不可上锁路径
            flipped = (sqlite.prepare('SELECT changes() AS n').get() as { n: number }).n > 0;
            if (flipped) {
                sqlite.prepare('DELETE FROM docs_fts WHERE doc_id = ?').run(docId);
                sqlite.prepare('INSERT INTO docs_fts (doc_id, name, content) VALUES (?, ?, ?)').run(docId, row.name, body);
            }
        });
        if (!flipped) return; // 本地刚写的文件留作孤儿，无害（spec §4.1）
        try {
            await store.delete(objectKeyFor(row));
        } catch (e) {
            console.warn('[tiering] 回热后删远端对象失败（孤儿对象，无害）', docId, e);
        }
    });
}

// ── 归档周期：批量扫描 + 失败隔离 ──────────────────────────────
export async function runArchiveCycle(store?: ObjectStore): Promise<number> {
    const s = store ?? getObjectStore();
    if (!s) return 0;
    const days = getColdTierAfterDays();
    const now = Date.now();
    const candidates = db.select().from(schema.documents)
        .where(eq(schema.documents.type, 'file'))
        .all()
        .filter((r) => isColdCandidate(r, now, days))
        .slice(0, ARCHIVE_BATCH_LIMIT);
    let archived = 0;
    for (const c of candidates) {
        try {
            if ((await archiveDocument(c, s, days)) === 'archived') archived++;
        } catch (e) {
            console.warn('[tiering] 归档失败，下轮重试', c.id, e);
        }
    }
    return archived;
}

// ── 调度器：启动即跑首轮（首轮失败即连通性告警，warn 不阻塞）+ 每小时一轮 ──
let schedulerStarted = false;

export function startTieringScheduler(): void {
    if (schedulerStarted) return;
    const store = getObjectStore();
    if (!store) return; // 未配置对象存储：分层整体关闭，行为与现状一致
    schedulerStarted = true;
    void runArchiveCycle(store)
        .then((n) => { if (n > 0) console.log('[tiering] 首轮归档完成', n, '篇'); })
        .catch((e) => console.warn('[tiering] 首轮归档失败（对象存储连通性待确认）', e));
    const timer = setInterval(() => {
        void runArchiveCycle(store).catch((e) => console.warn('[tiering] 归档周期失败', e));
    }, TIERING_INTERVAL_MS);
    timer.unref();
}
```

- [ ] **Step 3.5: 运行测试确认通过**

Run: `bun run test apps/web/tests/tiering.test.ts`
Expected: PASS ×11

- [ ] **Step 3.6: Commit**

```bash
git add apps/web/src/lib/server/tiering.ts apps/web/src/lib/server/env.ts apps/web/tests/tiering.test.ts
git commit -m "feat(web): 归档/回热引擎——冷判定、PUT→DB→unlink 状态机、docId 互斥锁、批量归档调度"
```

---

### Task 4: 读路径改造（readDocumentContent 单点 + 两路由 404/503 语义）

**Files:**
- Modify: `apps/web/src/lib/server/documents.ts`
- Modify: `apps/web/src/routes/s/[token]/+page.server.ts`
- Modify: `apps/web/src/routes/d/[id]/+page.server.ts`
- Test: `apps/web/tests/tiering-view.test.ts`

- [ ] **Step 4.1: 写失败测试**

创建 `apps/web/tests/tiering-view.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId, sha256Hex } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';
import { runArchiveCycle } from '../src/lib/server/tiering';
import { MemoryObjectStore, __setObjectStoreForTest, objectKeyFor } from '../src/lib/server/object-store';
import { createShareLink } from '../src/lib/server/shares';
import { eq } from 'drizzle-orm';

const DAY = 86_400_000;
let ownerId: string;
let store: MemoryObjectStore;
const TMP_DOCS = `./data/test-view-${Date.now().toString(36)}`;

const shareLoad = (await import('../src/routes/s/[token]/+page.server')).load;

function getDoc(id: string) {
    return db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!;
}
function callShareLoad(token: string) {
    return shareLoad({ params: { token }, setHeaders: () => {} } as unknown as Parameters<typeof shareLoad>[0]);
}

function getDocRow() {
    return db.select().from(schema.documents).where(eq(schema.documents.ownerId, ownerId)).get()!;
}

beforeEach(async () => {
    process.env.DATA_DIR = TMP_DOCS;
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId, email: `t-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    store = new MemoryObjectStore();
    __setObjectStoreForTest(store);
});

afterEach(() => {
    try { rmSync(TMP_DOCS, { recursive: true, force: true }); } catch {}
    __setObjectStoreForTest(undefined);
});

async function makeColdWithShare(content: string): Promise<string> {
    const r = await uploadDocument(ownerId, 'c.md', content, []);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    await runArchiveCycle(store);
    const { token } = await createShareLink(r.id); // 归档后 token 依然有效
    return token;
}

test('冷文档 + 有效 token → 正常渲染（内容来自远端）且触发异步回热', async () => {
    const token = await makeColdWithShare('# Cold View');
    const result = (await callShareLoad(token)) as { title: string; html: string };
    expect(result.html).toContain('<h1>Cold View</h1>');
    // 回热 fire-and-forget：轮询等待翻转（固定 sleep 在 CI 负载下会假红，回热链含 3 次真实磁盘 I/O）
    for (let i = 0; i < 100 && getDocRow().storageTier !== 'hot'; i++) {
        await new Promise((r) => setTimeout(r, 20));
    }
    expect(getDocRow().storageTier).toBe('hot');
    expect(store.data.size).toBe(0);
});

test('冷文档 + 远端不可达 → 503（区别于 404）', async () => {
    const token = await makeColdWithShare('# x');
    store.failGet = true;
    await expect(callShareLoad(token)).rejects.toMatchObject({ status: 503 });
});

test('冷文档 + 远端对象缺失 → 404 内容缺失', async () => {
    const token = await makeColdWithShare('# x');
    store.data.clear(); // 对象被误删
    await expect(callShareLoad(token)).rejects.toMatchObject({ status: 404 });
});

test('热文档访问 → last_viewed_at 刷新', async () => {
    const r = await uploadDocument(ownerId, 'h.md', '# Hot', []);
    db.update(schema.documents).set({ lastViewedAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    const before = getDoc(r.id).lastViewedAt!;
    const { token } = await createShareLink(r.id);
    await callShareLoad(token);
    expect(getDoc(r.id).lastViewedAt!).toBeGreaterThan(before);
});

test('冷文档 storagePath 保留不再是 404 条件（守卫放宽）', async () => {
    const token = await makeColdWithShare('# guard');
    const result = (await callShareLoad(token)) as { html: string };
    expect(result.html).toContain('<h1>guard</h1>');
});

// ── 自愈兜底（spec §7，双 Agent 交叉审查发现：陈旧行判定与实际状态竞态防假 404）──

test('自愈：陈旧行判冷、读取期间他方已回热 → 回落本地，不假 404（P1 回归）', async () => {
    await makeColdWithShare('# Race');
    const stale = getDocRow(); // storageTier === 'cold' 的快照视图
    // 模拟另一请求已完成回热：本地已写 + DB 翻 hot + 远端对象已删
    const { writeFile } = await import('../src/lib/server/storage');
    await writeFile(stale.storagePath!, '# Race');
    db.update(schema.documents).set({ storageTier: 'hot' }).where(eq(schema.documents.id, stale.id)).run();
    store.data.clear();
    const { readDocumentContent } = await import('../src/lib/server/documents');
    // stale.storageTier === 'cold' → 远端 get 落空（ObjectNotFound）→ 重取行已是 hot → 回落本地
    expect(await readDocumentContent(stale)).toBe('# Race');
});

test('自愈：陈旧行判热、读取期间归档刚完成 → 转走远端，不假 404', async () => {
    const r = await uploadDocument(ownerId, 'h.md', '# HotRace', []);
    const stale = getDocRow(); // storageTier === 'hot' 的快照视图
    // 模拟归档刚完成：对象已上远端 + DB 翻 cold + 本地已删
    await store.put(objectKeyFor(stale), '# HotRace');
    db.update(schema.documents).set({ storageTier: 'cold' }).where(eq(schema.documents.id, r.id)).run();
    const { unlink } = await import('node:fs/promises');
    await unlink(stale.storagePath!);
    const { readDocumentContent } = await import('../src/lib/server/documents');
    // stale.storageTier === 'hot' → 本地 readFile ENOENT → 重取行已是 cold → 转远端拉取
    expect(await readDocumentContent(stale)).toBe('# HotRace');
});
```

- [ ] **Step 4.2: 运行确认失败**

Run: `bun run test apps/web/tests/tiering-view.test.ts`
Expected: FAIL（冷文档在旧路径读本地已删文件 → ENOENT → 404「内容缺失」——`!doc.storagePath` 守卫因冷态保留 storagePath 不触发；另 lastViewedAt 不刷新）

- [ ] **Step 4.3: documents.ts 加 readDocumentContent / touchDocument**

`apps/web/src/lib/server/documents.ts` 顶部 import 区调整：

```ts
import { writeFile, readFile, FileNotFoundError } from './storage';
import { rewarmDocument, withDocLock } from './tiering';
import { getObjectStore, objectKeyFor, ObjectNotFoundError, ArchiveUnavailableError } from './object-store';
```

（`readFile`/`FileNotFoundError` 新增自 `./storage`；`withDocLock` 供 Task 5.3 覆盖上传上锁；其余为新 import。）

文件末尾追加：

```ts
// 冷热分层：访问时间戳（推迟冷却判定；只动 last_viewed_at，不动 updated_at 避免影响排序语义）
export function touchDocument(docId: string): void {
    db.update(schema.documents).set({ lastViewedAt: Date.now() })
        .where(eq(schema.documents.id, docId)).run();
}

// 内容读取单点：hot → 本地（现状路径）；cold → 远端拉取 + fire-and-forget 回热
// 错误语义：FileNotFoundError / ObjectNotFoundError → 路由 404；ArchiveUnavailableError → 路由 503
// 自愈兜底（spec §7）：陈旧行判定与实际状态竞态时（他方刚回热/刚归档）重取行走另一条路径，防假 404
export async function readDocumentContent(doc: DocumentRow): Promise<string> {
    touchDocument(doc.id);
    if (doc.storageTier === 'cold') {
        const store = getObjectStore();
        if (!store) throw new ArchiveUnavailableError('对象存储未配置，冷文档不可读');
        let content: string;
        try {
            content = await store.get(objectKeyFor(doc));
        } catch (e) {
            if (e instanceof ObjectNotFoundError) {
                // 读取期间他方回热已完成（远端对象已删、本地已写）→ 回落读本地
                const refetch = db.select().from(schema.documents).where(eq(schema.documents.id, doc.id)).get();
                if (refetch && refetch.storageTier === 'hot' && refetch.storagePath) {
                    return readFile(refetch.storagePath);
                }
            }
            throw e;
        }
        void rewarmDocument(doc.id, content).catch((e) => {
            console.warn('[tiering] 回热失败（下次访问重试）', doc.id, e);
        });
        return content;
    }
    if (!doc.storagePath) throw new FileNotFoundError(doc.id); // 防御：hot 必有盘路径
    try {
        return await readFile(doc.storagePath);
    } catch (e) {
        if (e instanceof FileNotFoundError) {
            // 读取期间归档刚完成（本地已删、远端已存）→ 转走远端
            const refetch = db.select().from(schema.documents).where(eq(schema.documents.id, doc.id)).get();
            if (refetch && refetch.storageTier === 'cold') {
                const store = getObjectStore();
                if (store) return store.get(objectKeyFor(refetch));
            }
        }
        throw e;
    }
}
```

- [ ] **Step 4.4: 改两条路由**

`apps/web/src/routes/s/[token]/+page.server.ts` 改为：

```ts
import { error } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { eq } from 'drizzle-orm';
import { db, schema } from '$server/db';
import { getDocumentIdByShareToken } from '$server/shares';
import { readDocumentContent } from '$server/documents';
import { FileNotFoundError } from '$server/storage';
import { ArchiveUnavailableError, ObjectNotFoundError } from '$server/object-store';
import { renderMarkdown } from '$server/markdown';

export const load: PageServerLoad = async ({ params, setHeaders }) => {
    const documentId = getDocumentIdByShareToken(params.token);
    if (!documentId) error(404, '链接已失效或不存在');

    const doc = db.select().from(schema.documents).where(eq(schema.documents.id, documentId)).get();
    // 冷热分层：storage_tier 是内容位置事实源，storagePath 冷态保留 → 不再作为 404 条件
    if (!doc || doc.type !== 'file') error(404, '文档不存在');

    let content: string;
    try {
        content = await readDocumentContent(doc);
    } catch (e) {
        if (e instanceof FileNotFoundError || e instanceof ObjectNotFoundError) error(404, '文档内容缺失');
        if (e instanceof ArchiveUnavailableError) error(503, '归档存储暂时不可达，请稍后重试');
        throw e;
    }
    const html = await renderMarkdown(content);
    // M1: 免登录查看页禁缓存——撤销 share token 后浏览器/CDN/bfcache 不再展示已撤销内容
    setHeaders({ 'cache-control': 'no-store' });
    return { title: doc.name, html };
};
```

`apps/web/src/routes/d/[id]/+page.server.ts` 的 load 段同构替换（保留 tags/actions 不动）。**import 改法（注意：该文件第 4 行已是 `import { readFile, FileNotFoundError } from '$server/storage';`——须将此行整体替换为下面的 FileNotFoundError 行，不能新增重复 import：同名绑定重复导入是 ESM/TS 编译错误，模块加载即崩，d-view.test.ts 会全红；`readFile` 在 load 改造后也不再使用）**：

```ts
import { FileNotFoundError } from '$server/storage';
import { readDocumentContent } from '$server/documents';
import { ArchiveUnavailableError, ObjectNotFoundError } from '$server/object-store';
```

load 内替换为：

```ts
    const doc = getOwnedDocument(params.id, locals.user.id);
    // 冷热分层：storage_tier 是内容位置事实源，storagePath 冷态保留 → 不再作为 404 条件
    if (!doc || doc.type !== 'file') error(404, '文档不存在');

    let content: string;
    try {
        content = await readDocumentContent(doc);
    } catch (e) {
        if (e instanceof FileNotFoundError || e instanceof ObjectNotFoundError) error(404, '文档内容缺失');
        if (e instanceof ArchiveUnavailableError) error(503, '归档存储暂时不可达，请稍后重试');
        throw e;
    }
    const html = await renderMarkdown(content);
```

（其余 `tags`/`setHeaders`/return 与 actions 保持原样。）

- [ ] **Step 4.5: 运行新测试 + 现有路由测试（share-view/d-view 必须零改动通过）**

Run: `bun run test apps/web/tests/tiering-view.test.ts apps/web/tests/share-view.test.ts apps/web/tests/d-view.test.ts`
Expected: 全部 PASS

- [ ] **Step 4.6: Commit**

```bash
git add apps/web/src/lib/server/documents.ts apps/web/src/routes/s apps/web/src/routes/d apps/web/tests/tiering-view.test.ts
git commit -m "feat(web): 读路径走 readDocumentContent——冷文档同步拉取+后台回热，503/404 语义分离"
```

---

### Task 5: 写路径冷态交互（覆盖上传回热 / rename 冷分支 / delete 远端清理）

**Files:**
- Modify: `apps/web/src/lib/server/documents.ts`
- Test: `apps/web/tests/documents.test.ts`（追加）

- [ ] **Step 5.1: 写失败测试**

在 `apps/web/tests/documents.test.ts` 追加（import 区补 `runArchiveCycle`、`MemoryObjectStore/__setObjectStoreForTest/objectKeyFor`；`beforeEach` 尾部加 `store = new MemoryObjectStore(); __setObjectStoreForTest(store);`，`afterEach` 加 `__setObjectStoreForTest(undefined);`，并声明 `let store: MemoryObjectStore;`）：

```ts
const DAY = 86_400_000;

async function makeCold(content: string, name = 'c.md'): Promise<string> {
    const r = await uploadDocument(ownerId, name, content, []);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY })
        .where(eq(schema.documents.id, r.id)).run();
    await runArchiveCycle(store);
    return r.id;
}

test('冷文档·覆盖上传（新内容）→ 回热 + 本地 v2 + 删旧远端对象', async () => {
    const id = await makeCold('v1');
    const oldKey = objectKeyFor(db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!);
    expect(store.data.has(oldKey)).toBe(true);
    await uploadDocument(ownerId, 'c.md', 'v2', []);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!;
    expect(row.storageTier).toBe('hot');
    expect(row.contentHash).toBe(sha256Hex('v2'));
    const { readFile } = await import('../src/lib/server/storage');
    expect(await readFile(row.storagePath!)).toBe('v2');
    await new Promise((r) => setTimeout(r, 20)); // 旧对象删除 fire-and-forget
    expect(store.data.has(oldKey)).toBe(false);
});

test('冷文档·幂等命中（同内容）→ 保持冷态、不写盘、时间戳未动', async () => {
    const id = await makeCold('same');
    const before = db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!;
    await uploadDocument(ownerId, 'c.md', 'same', []);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!;
    expect(row.storageTier).toBe('cold');
    expect(row.updatedAt).toBe(before.updatedAt); // 时间戳未动
});

test('冷文档·重命名 → 仅 DB（name+storagePath 更新），不触碰磁盘/远端', async () => {
    const id = await makeCold('x', 'old.md');
    const row0 = db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!;
    const key = objectKeyFor(row0);
    const r = renameNode(ownerId, id, 'new.md');
    expect(r.ok).toBe(true);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!;
    expect(row.name).toBe('new.md');
    expect(row.storagePath).toBe(join(dirname(row0.storagePath!), 'new.md'));
    expect(store.data.has(key)).toBe(true); // 远端对象未动（key 不含 name）
});

test('冷文档·删除 → 行删除 + 远端对象删除', async () => {
    const id = await makeCold('gone');
    const key = objectKeyFor(db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()!);
    deleteNode(ownerId, id);
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, id)).get()).toBeUndefined();
    await new Promise((r) => setTimeout(r, 20));
    expect(store.data.has(key)).toBe(false);
});
```

（import 区还需从 `node:path` 补 `join, dirname`——documents.test.ts 现无此 import 则加上。）

- [ ] **Step 5.2: 运行确认失败**

Run: `bun run test apps/web/tests/documents.test.ts`
Expected: 新增 4 例中 **3 例 FAIL**（覆盖上传 / rename / 删除——冷态交互未实现）；「幂等命中」例为回归守卫——现有代码本就不写盘不改时间戳，实现前后均应通过

- [ ] **Step 5.3: 改 uploadDocument 覆盖分支**

`documents.ts` 的 `uploadDocument` 中 `if (existing) { ... }` 分支改为：

```ts
    if (existing) {
        // §4.2：覆盖上传写段持 doc 锁（与归档/回热串行，防竞态丢内容）；锁内重取行拿最新状态
        return withDocLock(existing.id, async () => {
            const row = db.select().from(schema.documents).where(eq(schema.documents.id, existing.id)).get();
            // 锁等待期间行被删：重取与递归之间无 await（原子窗口），递归走全新插入、不会重入本锁
            if (!row) return uploadDocument(ownerId, name, content, pathSegments);
            // 锁内复查幂等：等锁期间内容可能已被并发上传改为相同内容
            if (row.contentHash === contentHash) {
                const url = await ensureShareUrl(row.id);
                return { id: row.id, url };
            }
            await writeFile(diskPath, content);
            db.update(schema.documents).set({
                storagePath: diskPath,
                contentHash,
                sizeBytes: Buffer.byteLength(content),
                updatedAt: now,
                // 覆盖上传即回热：内容已重新落盘
                storageTier: 'hot',
                lastViewedAt: now,
                archivedAt: null
            }).where(eq(schema.documents.id, row.id)).run();
            indexDoc(row.id, name, content);
            // 旧态为 cold：清理旧远端对象（旧 key 含旧 hash；失败仅留孤儿对象，无害）
            if (row.storageTier === 'cold') {
                const store = getObjectStore();
                if (store) {
                    void store.delete(objectKeyFor(row)).catch((e) => {
                        console.warn('[upload] 删除旧归档对象失败（孤儿对象，无害）', row.id, e);
                    });
                }
            }
            const url = await ensureShareUrl(row.id);
            return { id: row.id, url };
        });
    }
```

（锁外的幂等命中快路径——`existing && existing.contentHash === contentHash`——**保持原样不动**：findNode 到判断之间无 await、快照不会过期，不写盘不改时间戳不回热；锁内另设复查兜底并发窗口。）

新插入分支的 `db.insert(...).values({...})` 中显式加 `storageTier: 'hot', lastViewedAt: null, archivedAt: null,`（默认值显式化，防漂移）。

- [ ] **Step 5.4: 改 renameNode 冷分支**

`documents.ts` 的 `renameNode` 中磁盘段改为（tier 判断内移，cold 跳过 renameSync）：

```ts
    // #42: 文件重命名同步磁盘文件与 storagePath，避免 DB 名字与磁盘路径错位、覆盖上传留孤儿
    // 冷热分层：cold 无本地文件，跳过磁盘 rename，仅更新 DB（对象 key 不含 name，远端无需动）
    if (node.type === 'file' && node.storagePath) {
        const newPath = join(dirname(node.storagePath), newName);
        if (node.storageTier === 'hot') {
            try {
                renameSync(node.storagePath, newPath);
            } catch {
                return { ok: false, reason: '磁盘重命名失败', code: 'invalid' };
            }
        }
        db.update(schema.documents).set({ name: newName, storagePath: newPath, updatedAt: Date.now() })
            .where(and(eq(schema.documents.id, id), eq(schema.documents.ownerId, ownerId)))
            .run();
    } else {
        db.update(schema.documents).set({ name: newName, updatedAt: Date.now() })
            .where(and(eq(schema.documents.id, id), eq(schema.documents.ownerId, ownerId)))
            .run();
    }
```

- [ ] **Step 5.5: 改 deleteNode 远端清理**

`documents.ts` 的 `deleteNode` 中，文件收集查询改为：

```ts
    const files = db.select({
        id: schema.documents.id,
        storagePath: schema.documents.storagePath,
        storageTier: schema.documents.storageTier,
        contentHash: schema.documents.contentHash,
        ownerId: schema.documents.ownerId
    })
        .from(schema.documents)
        .where(and(inArray(schema.documents.id, subtreeIds), eq(schema.documents.type, 'file')))
        .all();
```

事务后的磁盘清理段改为：

```ts
    const store = getObjectStore();
    for (const f of files) {
        if (f.storageTier === 'cold') {
            // 冷文档：内容在远端（失败仅留孤儿对象，无害）
            if (store) {
                void store.delete(objectKeyFor(f)).catch((e) => {
                    console.warn('[deleteNode] 远端对象删除失败', f.id, e);
                });
            }
        } else if (f.storagePath) {
            try {
                rmSync(f.storagePath, { recursive: true, force: true });
            } catch (e) {
                console.warn('[deleteNode] disk cleanup failed', f.storagePath, e);
            }
        }
    }
```

- [ ] **Step 5.6: 运行测试确认通过**

Run: `bun run test apps/web/tests/documents.test.ts`
Expected: 全部 PASS（含原有用例）

- [ ] **Step 5.7: Commit**

```bash
git add apps/web/src/lib/server/documents.ts apps/web/tests/documents.test.ts
git commit -m "feat(web): 写路径冷态交互——覆盖上传回热+清旧对象、rename 冷分支、delete 连带远端清理"
```

---

### Task 6: FTS/搜索语义 + 搜索页「已归档」标记 + 文件管理器 badge

**Files:**
- Modify: `apps/web/src/lib/server/search.ts`
- Modify: `apps/web/src/routes/search/+page.svelte`
- Modify: `apps/web/src/routes/+page.svelte`
- Test: `apps/web/tests/tiering-search.test.ts`（新建）

- [ ] **Step 6.1: 写失败测试**

创建 `apps/web/tests/tiering-search.test.ts`：

```ts
import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';
import { runArchiveCycle, rewarmDocument } from '../src/lib/server/tiering';
import { MemoryObjectStore, __setObjectStoreForTest } from '../src/lib/server/object-store';
import { searchDocuments } from '../src/lib/server/search';
import { eq } from 'drizzle-orm';

const DAY = 86_400_000;
let ownerId: string;
let store: MemoryObjectStore;
const TMP_DOCS = `./data/test-srch-${Date.now().toString(36)}`;

beforeEach(async () => {
    process.env.DATA_DIR = TMP_DOCS;
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId, email: `t-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    store = new MemoryObjectStore();
    __setObjectStoreForTest(store);
});

afterEach(() => {
    try { rmSync(TMP_DOCS, { recursive: true, force: true }); } catch {}
    __setObjectStoreForTest(undefined);
});

test('归档后：内容词不可搜、标题可搜且 snippet 为空、storageTier 透出为 cold', async () => {
    const r = await uploadDocument(ownerId, 'quarterly-report.md', 'uniquebodytoken lorem', []);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    await runArchiveCycle(store);
    // 内容词（trigram ≥3 字符）不再命中
    expect(searchDocuments(ownerId, 'uniquebodytoken', []).length).toBe(0);
    // 标题命中
    const hits = searchDocuments(ownerId, 'quarterly', []);
    expect(hits.length).toBe(1);
    expect(hits[0].doc.storageTier).toBe('cold');
    expect(hits[0].snippet).toBe('');
});

test('回热后：内容词恢复可搜', async () => {
    const r = await uploadDocument(ownerId, 'n.md', 'rewarmbodytoken ipsum', []);
    db.update(schema.documents).set({ updatedAt: Date.now() - 40 * DAY }).where(eq(schema.documents.id, r.id)).run();
    await runArchiveCycle(store);
    await rewarmDocument(r.id, 'rewarmbodytoken ipsum');
    expect(searchDocuments(ownerId, 'rewarmbodytoken', []).length).toBe(1);
});
```

- [ ] **Step 6.2: 运行确认失败**

Run: `bun run test apps/web/tests/tiering-search.test.ts`
Expected: 第 1 例 FAIL——`hits[0].doc.storageTier` 为 `undefined`（search.ts 末段 `SELECT *` 返回 snake_case 键，`as DocumentRow` 是历史性谎言；本任务修正列别名）

- [ ] **Step 6.3: 修 search.ts 末段 SELECT（camelCase 别名）**

`searchDocuments` 末段的 docs 查询替换为：

```ts
    const docs = sqlite.prepare(`
        SELECT d.id, d.owner_id AS "ownerId", d.parent_id AS "parentId", d.name, d.type,
               d.storage_path AS "storagePath", d.content_hash AS "contentHash",
               d.size_bytes AS "sizeBytes", d.created_at AS "createdAt", d.updated_at AS "updatedAt",
               d.storage_tier AS "storageTier", d.last_viewed_at AS "lastViewedAt", d.archived_at AS "archivedAt"
        FROM documents d WHERE d.owner_id = ? AND d.id IN (${ph})
    `).all(ownerId, ...ids) as DocumentRow[];
```

（精准修改：`getDocPath` 的 SELECT 不动——其消费方只用 `name`。）

- [ ] **Step 6.4: 运行测试确认通过**

Run: `bun run test apps/web/tests/tiering-search.test.ts apps/web/tests/search.test.ts`
Expected: 全部 PASS（现有 search.test.ts 验证别名改动无回归）

- [ ] **Step 6.5: 搜索页 UI——冷文档 snippet 占位**

`apps/web/src/routes/search/+page.svelte` 中：

```svelte
                        {#if r.snippet}
                            <p class="snippet">{@html r.snippet}</p>
                        {/if}
```

替换为：

```svelte
                        {#if r.snippet}
                            <p class="snippet">{@html r.snippet}</p>
                        {:else if r.doc.storageTier === 'cold'}
                            <p class="snippet muted">☁️ 已归档（仅标题可搜）</p>
                        {/if}
```

- [ ] **Step 6.6: 文件管理器 badge**

`apps/web/src/routes/+page.svelte` 中文件链接行：

```svelte
                                    <a href="/d/{item.id}">📄 {item.name}</a>
```

其后追加一行：

```svelte
                                    {#if item.storageTier === 'cold'}<span class="chip-static cold-chip">☁️ 已归档</span>{/if}
```

并在该文件 `<style>` 段（`.name a:hover` 规则附近）追加：

```css
    .cold-chip { color: #57606a; font-weight: 400; }
```

- [ ] **Step 6.7: svelte-check 验证 UI 编译**

Run: `bun --filter remote-reader-web check`
Expected: 0 error（`item.storageTier` 经 listChildren 全行返回自动可用）

- [ ] **Step 6.8: Commit**

```bash
git add apps/web/src/lib/server/search.ts apps/web/src/routes/search/+page.svelte apps/web/src/routes/+page.svelte apps/web/tests/tiering-search.test.ts
git commit -m "feat(web): 冷文档标题可搜——FTS content 清空语义透出 + 搜索页/文件管理器「已归档」标记"
```

---

### Task 7: 启动校验（配置完整性 fail-fast）+ 调度器接线 + 配置样例 + 文档指针

**Files:**
- Modify: `apps/web/src/lib/server/startup-check.ts`
- Modify: `apps/web/src/hooks.server.ts`
- Modify: `.env.example`
- Modify: `CLAUDE.md`
- Test: `apps/web/tests/startup-check.test.ts`（追加）

- [ ] **Step 7.1: 写失败测试**

`apps/web/tests/startup-check.test.ts` 追加（文件顶部 import 区补 `beforeEach`）：

```ts
beforeEach(() => {
    for (const k of ['OBJECT_STORE_ENDPOINT', 'OBJECT_STORE_REGION', 'OBJECT_STORE_BUCKET', 'OBJECT_STORE_ACCESS_KEY_ID', 'OBJECT_STORE_SECRET_ACCESS_KEY']) {
        delete process.env[k];
    }
});

test('OBJECT_STORE_* 部分配置 → dev 也 fail-fast（确定性配置错误）', () => {
    process.env.NODE_ENV = 'development';
    process.env.OBJECT_STORE_BUCKET = 'b';
    expect(() => validateStartupConfig()).toThrow(/OBJECT_STORE|不完整/);
});

test('OBJECT_STORE_* 完整配置 → 不抛', () => {
    process.env.NODE_ENV = 'development';
    Object.assign(process.env, {
        OBJECT_STORE_ENDPOINT: 'https://s3.cn-east-1.qiniucs.com',
        OBJECT_STORE_REGION: 'cn-east-1',
        OBJECT_STORE_BUCKET: 'b',
        OBJECT_STORE_ACCESS_KEY_ID: 'ak',
        OBJECT_STORE_SECRET_ACCESS_KEY: 'sk'
    });
    expect(() => validateStartupConfig()).not.toThrow();
});
```

- [ ] **Step 7.2: 运行确认失败**

Run: `bun run test apps/web/tests/startup-check.test.ts`
Expected: 新增 2 例中 **1 例 FAIL**（部分配置例）；「完整配置 → 不抛」例为回归守卫——实现前 dev 早退同样不抛，实现后语义不变

- [ ] **Step 7.3: 改 startup-check.ts**

import 区加：

```ts
import { parseObjectStoreEnv } from './object-store';
import { sqlite } from './db';
```

`validateStartupConfig` 函数体最前（`if (process.env.NODE_ENV !== 'production') return;` **之前**）插入：

```ts
    // 冷热分层：任一 OBJECT_STORE_* 已配置但组合不完整 → fail-fast（全环境；确定性配置错误，spec §12）
    const objectStore = parseObjectStoreEnv();
    // 存量冷文档 + 未配置对象存储 → 这些文档将 503 直至恢复配置（数据仍在桶中，可恢复）：warn 不阻塞
    if (objectStore === null) {
        const cold = (sqlite.prepare("SELECT COUNT(*) AS c FROM documents WHERE storage_tier = 'cold'")
            .get() as { c: number }).c;
        if (cold > 0) {
            console.warn(`[startup] 存在 ${cold} 篇已归档文档但未配置 OBJECT_STORE_*，这些文档将不可读（503）直至恢复对象存储配置`);
        }
    }
```

- [ ] **Step 7.4: hooks.server.ts 接线**

`apps/web/src/hooks.server.ts` import 区加：

```ts
import { startTieringScheduler } from '$server/tiering';
```

`validateStartupConfig();` 之后加一行：

```ts
// 冷热分层调度：未配置对象存储时 no-op，行为与现状一致
startTieringScheduler();
```

- [ ] **Step 7.5: 运行测试确认通过**

Run: `bun run test apps/web/tests/startup-check.test.ts`
Expected: 全部 PASS

- [ ] **Step 7.6: .env.example 追加**

文件末尾追加：

```bash
# ── 冷热分层归档（可选；全部留空 = 关闭分层，文档只存本地）──
# S3 兼容对象存储。七牛 Kodo 示例：endpoint=https://s3.<region>.qiniucs.com
# 同一配置通接 AWS S3 / Cloudflare R2 / MinIO / 阿里云 OSS S3 网关 / 腾讯 COS
OBJECT_STORE_ENDPOINT=
OBJECT_STORE_REGION=
OBJECT_STORE_BUCKET=
OBJECT_STORE_ACCESS_KEY_ID=
OBJECT_STORE_SECRET_ACCESS_KEY=
# MinIO 等自建服务常需 path-style 寻址；七牛/AWS/R2 保持 false
OBJECT_STORE_FORCE_PATH_STYLE=false
# 冷判定阈值：N 天未访问且未更新 → 自动归档到对象存储（默认 30）
COLD_TIER_AFTER_DAYS=30
```

- [ ] **Step 7.7: CLAUDE.md 更新两处**

「当前状态」段末追加一行：

```markdown
**冷热分层归档（2026-09-04 设计定稿）**：冷文档（默认 30 天未访问）自动归档 S3 兼容对象存储（七牛/R2/OSS 网关/MinIO 通接），本地只留热文档；冷文档同步拉取可看+后台回热、标题可搜；未配置 OBJECT_STORE_* 行为不变。spec：`docs/superpowers/specs/2026-09-04-cold-hot-tiering-design.md`。
```

「环境变量」段 `PORT` 描述后追加：

```markdown
冷热分层：`OBJECT_STORE_ENDPOINT/REGION/BUCKET/ACCESS_KEY_ID/SECRET_ACCESS_KEY`（S3 兼容，全部留空=关闭）、`OBJECT_STORE_FORCE_PATH_STYLE`、`COLD_TIER_AFTER_DAYS`（默认 30）。
```

- [ ] **Step 7.8: Commit**

```bash
git add apps/web/src/lib/server/startup-check.ts apps/web/src/hooks.server.ts .env.example CLAUDE.md apps/web/tests/startup-check.test.ts
git commit -m "feat(web): 分层启动接线——OBJECT_STORE 配置完整性 fail-fast + 调度器启动 + 配置样例/文档"
```

---

### Task 8: 全量回归验证

- [ ] **Step 8.1: 全部测试**

Run: `bun run test`
Expected: 全部 PASS（含 259 存量 + 新增 35；现有测试文件除 documents.test.ts/startup-check.test.ts 的**追加**外零改动）

- [ ] **Step 8.2: 类型检查**

Run: `bun --filter remote-reader-web check && bun --filter remote-reader-mcp-bridge check`
Expected: 两项均 0 error（重点验证 @aws-sdk/client-s3 经 adapter-node/vite 无构建兼容问题——若 svelte-check 报 node内置模块相关错误，需在 `apps/web/vite.config.ts` 将 `@aws-sdk/client-s3` 加入 `ssr.external`，并重跑本步）

- [ ] **Step 8.3: 生产构建冒烟（SDK 打包验证）**

Run: `bun run build`
Expected: 构建成功产出 `apps/web/build/`（验证 adapter-node externalize 服务端依赖；若失败按 8.2 同法处理）

- [ ] **Step 8.4: Commit（如有修配）+ 最终提交**

```bash
git add -A
git commit -m "chore(web): 冷热分层回归收尾——全量测试/svelte-check/构建冒烟通过"
```

- [ ] **Step 8.5: （可选，需真实 bucket）七牛冒烟**

配置真实 `OBJECT_STORE_*` 指向七牛测试桶 → `bun run build && node apps/web/build/index.js` → 上传一篇文档 → 手动把 `documents.updated_at` 回拨 40 天（`sqlite3 data/app.db "UPDATE documents SET updated_at = strftime('%s','now')*1000 - 3456000000"`）→ 等 1 小时或重启触发首轮 → 确认七牛控制台出现 `archive/...` 对象、本地文件消失、`/s/<token>` 仍可打开且第二次打开变快（已回热）。

---

## Self-Review 记录

1. **Spec 覆盖**：§4 状态机+崩溃窗口（Task 3 测试逐点注入）、§4.2 互斥锁（Task 3 withDocLock）、§5 抽象层+key（Task 2）、§6 归档引擎（Task 3：判定/批 50/hash 防线/失败隔离）、§7 读路径+503/404+touch（Task 4）、§8 写路径四交互（Task 5）、§9 FTS（Task 3+6）、§10 UI badge（Task 6）、§11 schema 三处一致（Task 1）、§12 配置+fail-fast+向后兼容（Task 2/7，回归门在 1.7/4.5/8.1）、§13 测试策略（各 Task）、§14 安全（key 含 ownerId 隔离、hash 防线、渲染层不变——Task 3/6）。§15 实现顺序 = 本计划任务序。
2. **占位符扫描**：无 TBD/TODO；所有代码步骤含完整代码；所有 Run 命令含期望输出。
3. **类型一致性**：`storageTier`（drizzle camel）/`storage_tier`（raw SQL snake）在 search.ts 别名修正后统一为 camel 出口；`objectKeyFor` 签名在 Task 2 定义、Task 3/5 复用一致；`readDocumentContent(doc: DocumentRow)` 与两路由传入的 drizzle 行一致；`withDocLock` Task 3 定义并导出、测试直接引用。
4. **双 Agent 交叉审查轮（2026-09-04，Oracle 架构 + Momus 计划；全部发现经人工复核属实、无幻觉）**：
   - **P0 归档/覆盖上传竞态丢内容 + P1 回热 FTS 无守卫倒退**（Oracle 1/2）→ §4.2 升级为三段互斥（归档/回热/覆盖上传写段均持 doc 锁）+ 事务 `SELECT changes()` 翻转验证；落地于 Task 3.4（archiveDocument/rewarmDocument）与 Task 5.3（uploadDocument 上锁+锁内重取），并新增 2 个 gate 注入竞态回归测试（Task 3.2）。
   - **P1 并发双读假 404**（Oracle 3）+ P2 热读撞归档 unlink（Oracle 4）→ readDocumentContent 双向自愈兜底（Task 4.3）+ 2 个测试（Task 4.1 tiering-view）。
   - **P2×5**（Oracle 5-8）→ 锁内复查冷判定（Task 3.4）、S3 requestTimeout/maxAttempts（Task 2.5）、冷存量启动告警（Task 7.3）、spec §4.1 孤儿措辞降级、30ms 固定等待改轮询。
   - **Momus P1 d/[id] 重复 import 指令** → Task 4.4 改为整行替换说明；**P2×4** → Task 5.2/7.2 预期输出修正（3/4、1/2 红例）、Task 3.5 计数 ×11、Step 8.1 计数 35；ObjectNotFoundError 未用 import 随自愈兜底自然转为已用。

---

## 执行记录（2026-09-04 实际落地，分支 feature/cold-hot-tiering）

| 项 | 计划 | 实际 | 说明 |
|---|---|---|---|
| Step 2.1/2.5 S3 超时 | `requestTimeout: 5_000` 直配 | `requestHandler: new NodeHttpHandler({ requestTimeout: 5_000 })` | `requestTimeout` 非 `S3ClientConfig` 合法键（svelte-check 抓出），v3 须走 requestHandler；`@smithy/node-http-handler` 加为显式依赖 |
| Task 3 测试夹具 | 回拨仅 `updatedAt` | 回拨 `updatedAt` + `createdAt` | `isColdCandidate` 取 `max(last_viewed ?? created, updated)`，单拨 updatedAt 时 max=now 永不判冷——夹具不真实（真实旧文档两时间戳都旧）；纯函数夹具同步修正 |
| Task 3 竞态测试 | 11 例含 2 个 gate 竞态 | Task 3 提交 9 例，2 个竞态回归移至 Task 5 落地 | 竞态测试依赖 Task 5.3 的覆盖上传上锁；Task 3 时正确地红（证明 P0 检测有效），Task 5 后正确地绿 |
| Step 8.1 计数 | 259+35 | **294/294 全过** | 另：svelte-check 0 错（3 个存量 autofocus warning 非本次引入）、桥 tsc 0 错、adapter-node 生产构建冒烟通过（9.5M） |

提交序列：351886b（Task 1）→ cb20737（Task 2）→ deb08aa（Task 3）→ a2dd334（Task 4）→ 4f34571（Task 5）→ e27b4bd+06f7394（Task 6）→ 3bf6ef8（Task 7）。
