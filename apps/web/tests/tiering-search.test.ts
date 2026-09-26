import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { db, schema } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';
import { runArchiveCycle, rewarmDocument } from '../src/lib/server/tiering';
import { MemoryObjectStore, __setObjectStoreForTest } from '../src/lib/server/object-store';
import { searchDocuments } from '../src/lib/server/search';
import { eq } from 'drizzle-orm';

import { resetDb } from './helpers';
const DAY = 86_400_000;
let ownerId: string;
let store: MemoryObjectStore;
const TMP_DOCS = `./data/test-srch-${Date.now().toString(36)}`;

beforeEach(async () => {
    process.env.DATA_DIR = TMP_DOCS;
    resetDb();
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
    delete process.env.DATA_DIR; // 不留悬挂 env 指向已删目录（与 blobstore-local 纪律对齐）
});

test('归档后：内容词不可搜、标题可搜且 snippet 为空、storageTier 透出为 cold', async () => {
    const r = await uploadDocument(ownerId, 'quarterly-report.md', 'uniquebodytoken lorem', []);
    db.update(schema.documents)
        .set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY })
        .where(eq(schema.documents.id, r.id)).run();
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
    db.update(schema.documents)
        .set({ updatedAt: Date.now() - 40 * DAY, createdAt: Date.now() - 40 * DAY })
        .where(eq(schema.documents.id, r.id)).run();
    await runArchiveCycle(store);
    await rewarmDocument(r.id, 'rewarmbodytoken ipsum');
    expect(searchDocuments(ownerId, 'rewarmbodytoken', []).length).toBe(1);
});
