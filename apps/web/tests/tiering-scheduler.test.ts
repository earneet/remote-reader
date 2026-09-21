import { it, expect, beforeEach, afterAll, vi } from 'vitest';
import { db, schema, sqlite } from '$server/db';
import { resetDb } from './helpers';
import { startTieringScheduler, TIERING_INTERVAL_MS } from '$server/tiering';
import { __setObjectStoreForTest } from '$server/object-store';
import { __setBlobStoresForTest } from '$server/blobstore';
import { LocalBlobStore } from '$server/blobstore-local';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// P1-2（Task 7）：无 OBJECT_STORE_* 的默认部署（local 图片后端）下调度器也必须存在，
// 且 interval tick 必须调度 runImageGcCycle。
// schedulerStarted 是模块级单例且无重置钩子 → startTieringScheduler 全进程只能有效调用一次，
// 本文件因此独立成文件且只含单一用例。
const OBJECT_STORE_KEYS = [
    'OBJECT_STORE_ENDPOINT',
    'OBJECT_STORE_REGION',
    'OBJECT_STORE_BUCKET',
    'OBJECT_STORE_ACCESS_KEY_ID',
    'OBJECT_STORE_SECRET_ACCESS_KEY'
] as const;
const savedEnv: Record<string, string | undefined> = {};
for (const k of OBJECT_STORE_KEYS) savedEnv[k] = process.env[k];

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-tiersched-'));
process.env.DATA_DIR = DIR;

afterAll(() => {
    vi.useRealTimers();
    for (const k of OBJECT_STORE_KEYS) {
        if (savedEnv[k] === undefined) delete process.env[k];
        else process.env[k] = savedEnv[k];
    }
    __setObjectStoreForTest(undefined);
    __setBlobStoresForTest(undefined);
    delete process.env.DATA_DIR;
    fs.rmSync(DIR, { recursive: true, force: true });
});

beforeEach(() => {
    resetDb();
    __setBlobStoresForTest({ local: new LocalBlobStore() });
});

it('无对象存储环境：调度器启动且 runImageGcCycle 被 tick 调度（超时 pending 行被物理删）', async () => {
    // 前置：五键全清 + 清对象存储单例缓存 → getObjectStore() 重读 env 得 null（runArchiveCycle 无害 return 0）
    for (const k of OBJECT_STORE_KEYS) delete process.env[k];
    __setObjectStoreForTest(undefined);

    sqlite.exec(`INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('u1', 'u1@t.local', 'x', 'member', 0)`);
    sqlite.exec(`INSERT INTO images (id, owner_id, name, content_hash, content_md5, mime_type, size_bytes, status, storage_backend, storage_key, created_at, ready_at)
        VALUES ('img-stale', 'u1', 'stale.png', '${'a'.repeat(64)}', '${'a'.repeat(32)}', 'image/png', 1, 'pending', 'local', 'u1/blobs/aa/${'a'.repeat(64)}', 0, NULL)`);

    vi.useFakeTimers();
    try {
        startTieringScheduler(); // 旧实现在 store 为 null 时直接 return → interval 从未注册
        // 必须用 Async 版：tick 回调内 fire-and-forget promise 需微任务刷新后断言才可靠
        await vi.advanceTimersByTimeAsync(TIERING_INTERVAL_MS + 1);
    } finally {
        vi.useRealTimers();
    }

    const row = db.select().from(schema.images).where(eq(schema.images.id, 'img-stale')).get();
    expect(row).toBeUndefined(); // tick 调度的 runImageGcCycle 已物理删除超时（created_at=0）pending 行
});
