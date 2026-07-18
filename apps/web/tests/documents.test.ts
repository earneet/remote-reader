import { test, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { db, schema } from '../src/lib/server/db';
import { hashPassword, generateId, sha256Hex } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';
import { eq } from 'drizzle-orm';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '../src/lib/server/db/migrations');

let ownerId: string;
const TMP_DOCS = `./data/test-docs-${Date.now().toString(36)}`;

beforeAll(() => {
    migrate(db, { migrationsFolder });
});

beforeEach(async () => {
    process.env.DATA_DIR = TMP_DOCS;
    db.delete(schema.shareLinks).run();
    db.delete(schema.documents).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    db.insert(schema.users).values({
        id: ownerId,
        email: `t-${Date.now()}@x.com`,
        passwordHash: await hashPassword('x'),
        role: 'member',
        createdAt: Date.now()
    }).run();
});

afterEach(() => {
    try {
        rmSync(TMP_DOCS, { recursive: true, force: true });
    } catch {}
});

test('首次上传创建文档并返回 url', async () => {
    const r = await uploadDocument(ownerId, 'weekly.md', '# v1', ['reports']);
    expect(r.id).toBeTruthy();
    expect(r.url).toMatch(/\/s\//);
});

test('相同内容重复上传：id 不变、url 仍有效', async () => {
    const a = await uploadDocument(ownerId, 'd.md', 'same', []);
    const b = await uploadDocument(ownerId, 'd.md', 'same', []);
    expect(b.id).toBe(a.id);
    expect(b.url).toMatch(/\/s\//);
});

test('相同内容重复上传不新建文档行（幂等）', async () => {
    await uploadDocument(ownerId, 'd.md', 'same', []);
    await uploadDocument(ownerId, 'd.md', 'same', []);
    const files = db.select().from(schema.documents).where(eq(schema.documents.type, 'file')).all();
    expect(files.length).toBe(1);
    const shares = db.select().from(schema.shareLinks).all();
    expect(shares.length).toBe(1);
});

test('不同内容覆盖：id 不变、hash 更新为最新内容', async () => {
    const a = await uploadDocument(ownerId, 'd.md', 'v1', []);
    await uploadDocument(ownerId, 'd.md', 'v2', []);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, a.id)).get();
    expect(row?.contentHash).toBe(sha256Hex('v2'));
    expect(row?.sizeBytes).toBe(2);
});

test('嵌套路径级联创建文件夹且复用（不重复建）', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['reports', '2026']);
    await uploadDocument(ownerId, 'b.md', 'y', ['reports', '2026']);
    const folders = db.select().from(schema.documents).where(eq(schema.documents.type, 'folder')).all();
    expect(folders.length).toBe(2);
});

test('根目录文件（pathSegments 为空）parentId 为 null', async () => {
    const r = await uploadDocument(ownerId, 'root.md', '# hi', []);
    expect(r.url).toMatch(/\/s\//);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get();
    expect(row?.parentId).toBe(null);
    expect(row?.type).toBe('file');
});
