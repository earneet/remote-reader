import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db, schema, sqlite } from '$server/db';
import { resetDb } from './helpers';
import { uploadDocument, deleteNode } from '$server/documents';
import { initImage, relayImage } from '$server/images';
import { LocalBlobStore } from '$server/blobstore-local';
import { __setBlobStoresForTest } from '$server/blobstore';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

// Task 7 集成测试：documents.ts 挂载点（uploadDocument 新建/覆盖/幂等三分支 + deleteNode）
// 的 refs 登记与 GC 触发行为（spec §9.3 触发一/二）
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-imgtrig-'));
process.env.DATA_DIR = DIR;
afterAll(() => {
    delete process.env.DATA_DIR;
    __setBlobStoresForTest(undefined);
    fs.rmSync(DIR, { recursive: true, force: true });
});

beforeEach(() => {
    resetDb();
    __setBlobStoresForTest({ local: new LocalBlobStore() });
});

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const pngBytes = (seed: number): Buffer => Buffer.concat([PNG_MAGIC, Buffer.alloc(120, seed)]);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex');

// fire-and-forget 的 void promise（refs 事务后的 GC / blob unlink 走线程池）沉降后再断言文件系统终态：
// 全量联跑高负载下单轮 setImmediate 可能先于 fs 回调执行——多轮轮询（每轮含 poll 阶段）兜住
const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function mkUser(id: string): void {
    sqlite.exec(`INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('${id}', '${id}@t.local', 'x', 'member', 0)`);
}

// 正路建 ready 图：initImage + relayImage 真实 PNG 字节（不同 seed = 不同 hash → 不撞去重池）
async function mkReadyImage(ownerId: string, name: string, data: Buffer): Promise<string> {
    const init = await initImage(ownerId, { name, contentHash: sha256(data), contentMd5: md5(data), sizeBytes: data.length });
    if (init.status === 'exists') throw new Error(`mkReadyImage 撞去重池（${name}）`);
    const r = await relayImage(ownerId, init.imageId, data);
    if (!r.ok) throw new Error(`mkReadyImage relay 失败: ${JSON.stringify(r)}`);
    return init.imageId;
}

const imageRow = (id: string) => db.select().from(schema.images).where(eq(schema.images.id, id)).get();
const refRows = (docId: string) => db.select().from(schema.imageRefs).where(eq(schema.imageRefs.documentId, docId)).all();
const refCreatedAt = (docId: string, imageId: string): number | undefined =>
    db.select().from(schema.imageRefs)
        .where(and(eq(schema.imageRefs.documentId, docId), eq(schema.imageRefs.imageId, imageId))).get()?.createdAt;
const blobPath = (id: string): string => path.join(DIR, imageRow(id)!.storageKey);

describe('uploadDocument 挂载（新建/覆盖/幂等三分支）', () => {
    it('新建带图 md → refs 登记（image_refs 行存在）', async () => {
        mkUser('u1');
        const a = await mkReadyImage('u1', 'a.png', pngBytes(1));
        const r = await uploadDocument('u1', 'doc.md', '![x](a.png)', []);
        expect(refRows(r.id).map((x) => x.imageId)).toEqual([a]);
    });

    it('幂等重传（同内容）→ refs 不重算（created_at 不变、行数不变）', async () => {
        mkUser('u1');
        const a = await mkReadyImage('u1', 'a.png', pngBytes(1));
        const r = await uploadDocument('u1', 'doc.md', '![x](a.png)', []);
        const before = refCreatedAt(r.id, a);
        expect(before).toBeGreaterThan(0);
        const again = await uploadDocument('u1', 'doc.md', '![x](a.png)', []);
        expect(again.id).toBe(r.id);
        expect(refRows(r.id)).toHaveLength(1);
        expect(refCreatedAt(r.id, a)).toBe(before); // 幂等分支零操作：不触 refs 终态
    });

    it('覆盖移除引用（新内容无图）→ refs 归零 → 软删墓碑 + blob 文件删', async () => {
        mkUser('u1');
        const a = await mkReadyImage('u1', 'a.png', pngBytes(1));
        const r = await uploadDocument('u1', 'doc.md', '![x](a.png)', []);
        expect(fs.existsSync(blobPath(a))).toBe(true);
        await uploadDocument('u1', 'doc.md', '覆盖后只剩文字，没有图了', []);
        await flush();
        expect(refRows(r.id)).toEqual([]);
        expect(imageRow(a)!.status).toBe('deleted');   // 墓碑（行保留）
        expect(fs.existsSync(blobPath(a))).toBe(false); // blob 已删
    });

    it('覆盖仍引用（R1 关键场景）→ 图仍 ready 未被 GC、ref created_at 不变', async () => {
        mkUser('u1');
        const a = await mkReadyImage('u1', 'a.png', pngBytes(1));
        const r = await uploadDocument('u1', 'doc.md', '![x](a.png)', []);
        const before = refCreatedAt(r.id, a);
        await uploadDocument('u1', 'doc.md', '# v2\n\n![x](a.png)\n', []);
        await flush();
        expect(imageRow(a)!.status).toBe('ready'); // 唯一引用者覆盖后仍引用 → 从未归零 → 不触发 GC
        expect(refCreatedAt(r.id, a)).toBe(before);
        expect(fs.existsSync(blobPath(a))).toBe(true);
    });
});

describe('deleteNode 挂载（快照 → CASCADE 删 refs → 终态 GC）', () => {
    it('删含图文档 → 快照图归零 → 墓碑 + blob 删', async () => {
        mkUser('u1');
        const a = await mkReadyImage('u1', 'a.png', pngBytes(1));
        const r = await uploadDocument('u1', 'doc.md', '![x](a.png)', []);
        deleteNode('u1', r.id);
        await flush();
        expect(refRows(r.id)).toEqual([]);              // CASCADE 已清 refs 行
        expect(imageRow(a)!.status).toBe('deleted');
        expect(fs.existsSync(blobPath(a))).toBe(false);
    });

    it('一图被两文档引用 → 删一个文档后图仍 ready', async () => {
        mkUser('u1');
        const a = await mkReadyImage('u1', 'a.png', pngBytes(1));
        const d1 = await uploadDocument('u1', 'd1.md', '![x](a.png)', []);
        const d2 = await uploadDocument('u1', 'd2.md', '![x](a.png)', []);
        deleteNode('u1', d1.id);
        await flush();
        expect(imageRow(a)!.status).toBe('ready');      // 仍有 d2 引用 → 不动
        expect(fs.existsSync(blobPath(a))).toBe(true);
        expect(refRows(d2.id).map((x) => x.imageId)).toEqual([a]);
    });

    it('删文件夹（子树两个 md 各引用不同图）→ 两图都被 GC', async () => {
        mkUser('u1');
        const a = await mkReadyImage('u1', 'a.png', pngBytes(1));
        const b = await mkReadyImage('u1', 'b.png', pngBytes(2));
        await uploadDocument('u1', 'm1.md', '![x](a.png)', ['docs']);
        await uploadDocument('u1', 'm2.md', '![y](b.png)', ['docs']);
        const folder = db.select().from(schema.documents)
            .where(and(
                eq(schema.documents.ownerId, 'u1'),
                eq(schema.documents.name, 'docs'),
                eq(schema.documents.type, 'folder')
            ))
            .get()!;
        deleteNode('u1', folder.id);
        await flush();
        expect(imageRow(a)!.status).toBe('deleted');
        expect(imageRow(b)!.status).toBe('deleted');
        expect(fs.existsSync(blobPath(a))).toBe(false);
        expect(fs.existsSync(blobPath(b))).toBe(false);
    });
});
