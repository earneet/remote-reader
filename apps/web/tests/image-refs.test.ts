import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db, schema, sqlite } from '$server/db';
import { resetDb } from './helpers';
import { initImage, relayImage } from '$server/images';
import {
    registerDocumentRefs, gcImagesIfUnreferenced, lazyRegisterRefs,
    snapshotRefsForDocuments, runImageGcCycle
} from '$server/image-refs';
import { LocalBlobStore } from '$server/blobstore-local';
import { __setBlobStoresForTest } from '$server/blobstore';
import { and, eq } from 'drizzle-orm';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-imgrefs-'));
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
// seed > 255 时 Buffer.alloc fill 取 mod 256 会撞 hash（600 行测试实测只产出 256 唯一值）——
// 大规模种子用尾部写全序号字节保证唯一
const uniqPng = (seed: number): Buffer =>
    Buffer.concat([PNG_MAGIC, Buffer.alloc(118, 7), Buffer.of(seed & 0xff, (seed >>> 8) & 0xff)]);
const sha256 = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const md5 = (b: Buffer): string => createHash('md5').update(b).digest('hex');

// fire-and-forget 的 void promise（blob unlink 走线程池）沉降后再断言文件系统终态：
// 全量联跑高负载下单轮 setImmediate 可能先于 fs 回调执行——多轮轮询（每轮含 poll 阶段）兜住
const flush = async (): Promise<void> => {
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));
};

function mkUser(id: string): void {
    sqlite.exec(`INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('${id}', '${id}@t.local', 'x', 'member', 0)`);
}
function mkDoc(id: string, ownerId: string, contentHash: string | null = null): void {
    sqlite.exec(`INSERT INTO documents (id, owner_id, name, type, content_hash, created_at, updated_at)
        VALUES ('${id}', '${ownerId}', '${id}.md', 'file', ${contentHash === null ? 'NULL' : `'${contentHash}'`}, 0, 0)`);
}

// 正路建 ready 图：initImage + relayImage 真实 PNG 字节（不同 seed = 不同 hash → 不撞去重池）
async function mkReadyImage(ownerId: string, name: string, data: Buffer): Promise<string> {
    const init = await initImage(ownerId, { name, contentHash: sha256(data), contentMd5: md5(data), sizeBytes: data.length });
    if (init.status === 'exists') throw new Error(`mkReadyImage 撞去重池（${name}）`);
    const r = await relayImage(ownerId, init.imageId, data);
    if (!r.ok) throw new Error(`mkReadyImage relay 失败: ${JSON.stringify(r)}`);
    return init.imageId;
}
async function mkPendingImage(ownerId: string, name: string, data: Buffer): Promise<string> {
    const init = await initImage(ownerId, { name, contentHash: sha256(data), contentMd5: md5(data), sizeBytes: data.length });
    if (init.status === 'exists') throw new Error(`mkPendingImage 撞去重池（${name}）`);
    return init.imageId;
}

const imageRow = (id: string) => db.select().from(schema.images).where(eq(schema.images.id, id)).get();
const refRows = (docId: string) => db.select().from(schema.imageRefs).where(eq(schema.imageRefs.documentId, docId)).all();
const refCreatedAt = (docId: string, imageId: string): number | undefined =>
    db.select().from(schema.imageRefs)
        .where(and(eq(schema.imageRefs.documentId, docId), eq(schema.imageRefs.imageId, imageId))).get()?.createdAt;
const blobPath = (id: string): string => path.join(DIR, imageRow(id)!.storageKey);

describe('registerDocumentRefs（声明式登记，spec §9.1/§9.2）', () => {
    it('创建场景：md 引用 a.png/b.png → 两 refs INSERT；重复调用幂等（created_at 不变）', async () => {
        mkUser('u1');
        const a = await mkReadyImage('u1', 'a.png', pngBytes(1));
        const b = await mkReadyImage('u1', 'b.png', pngBytes(2));
        mkDoc('d1', 'u1');
        registerDocumentRefs('u1', 'd1', '![x](a.png) ![y](b.png)');
        expect(refRows('d1').map((r) => r.imageId).sort()).toEqual([a, b].sort());
        const before = refCreatedAt('d1', a);
        expect(before).toBeGreaterThan(0);
        registerDocumentRefs('u1', 'd1', '![x](a.png) ![y](b.png)'); // INSERT OR IGNORE 幂等
        expect(refRows('d1')).toHaveLength(2);
        expect(refCreatedAt('d1', a)).toBe(before); // 幂等：不重写 created_at
    });

    it('pending 行命中 → 不进 refs 但 created_at 续期（P2-6：防 1h 回收释放被引用的名字）', async () => {
        mkUser('u1');
        const p = await mkPendingImage('u1', 'p.png', pngBytes(1));
        sqlite.exec(`UPDATE images SET created_at=0 WHERE id='${p}'`);
        mkDoc('d1', 'u1');
        registerDocumentRefs('u1', 'd1', '![x](p.png)');
        expect(refRows('d1')).toEqual([]);            // pending 不登记 ref
        expect(imageRow(p)!.createdAt).toBeGreaterThan(0); // 续期为 now
    });

    it('无行 / 非 ready 名 → 忽略（refs 不增）', async () => {
        mkUser('u1');
        const dead = await mkReadyImage('u1', 'dead.png', pngBytes(1));
        sqlite.exec(`UPDATE images SET status='deleted' WHERE id='${dead}'`);
        mkDoc('d1', 'u1');
        registerDocumentRefs('u1', 'd1', '![g](ghost.png) ![d](dead.png)');
        expect(refRows('d1')).toEqual([]);
    });

    it('覆盖场景 R1：old={I1,I2} new={I2,I3} → refs=={I2,I3}，I2 ref created_at 未变（不变集零操作）', async () => {
        mkUser('u1');
        const i1 = await mkReadyImage('u1', 'i1.png', pngBytes(1));
        const i2 = await mkReadyImage('u1', 'i2.png', pngBytes(2));
        const i3 = await mkReadyImage('u1', 'i3.png', pngBytes(3));
        mkDoc('d1', 'u1');
        registerDocumentRefs('u1', 'd1', '![1](i1.png) ![2](i2.png)');
        const i2At = refCreatedAt('d1', i2);
        registerDocumentRefs('u1', 'd1', '![2](i2.png) ![3](i3.png)');
        expect(refRows('d1').map((r) => r.imageId).sort()).toEqual([i2, i3].sort());
        expect(refCreatedAt('d1', i2)).toBe(i2At); // I2 ∈ old∩new：原地不动（零操作证据）
        await flush(); // I1 归零触发 fire-and-forget GC，刷完微任务再进下一用例
    });

    it('R1 关键场景：唯一引用者覆盖后仍引用 I → I 从未归零 → 仍 ready 未被 GC', async () => {
        mkUser('u1');
        const keep = await mkReadyImage('u1', 'keep.png', pngBytes(1));
        mkDoc('d1', 'u1');
        registerDocumentRefs('u1', 'd1', '![x](keep.png)');
        const keepAt = refCreatedAt('d1', keep);
        registerDocumentRefs('u1', 'd1', '![x](keep.png) 加些文字');
        await flush();
        expect(imageRow(keep)!.status).toBe('ready'); // 从未归零 → 不在 GC 名单
        expect(refCreatedAt('d1', keep)).toBe(keepAt);
        expect(fs.existsSync(blobPath(keep))).toBe(true);
    });

    it('toRemove 归零 → 软删墓碑 + blob 物理删除（LocalBlobStore 落盘断言）', async () => {
        mkUser('u1');
        const gone = await mkReadyImage('u1', 'gone.png', pngBytes(1));
        mkDoc('d1', 'u1');
        registerDocumentRefs('u1', 'd1', '![x](gone.png)');
        expect(fs.existsSync(blobPath(gone))).toBe(true);
        registerDocumentRefs('u1', 'd1', '覆盖后不再引用图片');
        await flush();
        expect(imageRow(gone)!.status).toBe('deleted');       // 墓碑（行保留）
        expect(fs.existsSync(blobPath(gone))).toBe(false);    // blob 已删
    });

    it('§4.3-2 反查：toRemove 软删后同 key 有新活行 → blob 不删（封死延迟 DELETE 误删活图）', async () => {
        mkUser('u1');
        const gone = await mkReadyImage('u1', 'gone.png', pngBytes(1));
        const key = imageRow(gone)!.storageKey;
        mkDoc('d1', 'u1');
        registerDocumentRefs('u1', 'd1', '![x](gone.png)');
        // 同 key 新 pending 活行（hash/名异绕开两个 UNIQUE——模拟行删后重传同 key 的竞态终态）
        sqlite.exec(`INSERT INTO images (id, owner_id, name, content_hash, content_md5, mime_type, size_bytes, status, storage_backend, storage_key, created_at, ready_at)
            VALUES ('img-reuse', 'u1', 'reuse.png', '${'f'.repeat(64)}', '${'f'.repeat(32)}', 'image/png', 1, 'pending', 'local', '${key}', 0, NULL)`);
        registerDocumentRefs('u1', 'd1', '覆盖移除引用');
        await flush();
        expect(imageRow(gone)!.status).toBe('deleted');
        expect(fs.existsSync(path.join(DIR, key))).toBe(true); // 活行复用同 key → 跳过删除，下轮再看
    });
});

describe('gcImagesIfUnreferenced（§4.3-1/2/4）', () => {
    it('refs==0 → 软删 + blob 删；已有 ref → 不动', async () => {
        mkUser('u1');
        const orphan = await mkReadyImage('u1', 'orphan.png', pngBytes(1));
        const kept = await mkReadyImage('u1', 'kept.png', pngBytes(2));
        mkDoc('d1', 'u1');
        registerDocumentRefs('u1', 'd1', '![k](kept.png)');
        await gcImagesIfUnreferenced([orphan, kept]);
        await flush();
        expect(imageRow(orphan)!.status).toBe('deleted');
        expect(fs.existsSync(blobPath(orphan))).toBe(false);
        expect(imageRow(kept)!.status).toBe('ready');
        expect(fs.existsSync(blobPath(kept))).toBe(true);
    });

    it('条件式：status 已是 deleted → UPDATE 0 行幂等跳过（不抛错）', async () => {
        mkUser('u1');
        const dead = await mkReadyImage('u1', 'dead.png', pngBytes(1));
        sqlite.exec(`UPDATE images SET status='deleted' WHERE id='${dead}'`);
        await expect(gcImagesIfUnreferenced([dead])).resolves.toBeUndefined();
    });
});

describe('lazyRegisterRefs（P1-4 content-hash 守卫）', () => {
    it('hash 匹配 → INSERT 成功', async () => {
        mkUser('u1');
        const a = await mkReadyImage('u1', 'a.png', pngBytes(1));
        mkDoc('d1', 'u1', 'h1');
        lazyRegisterRefs('u1', 'd1', 'h1', ['a.png']);
        expect(refRows('d1').map((r) => r.imageId)).toEqual([a]);
    });

    it('hash 不匹配（渲染期间文档被覆盖）→ 跳过，refs 不增', async () => {
        mkUser('u1');
        await mkReadyImage('u1', 'a.png', pngBytes(1));
        mkDoc('d1', 'u1', 'h2');
        lazyRegisterRefs('u1', 'd1', 'stale-hash', ['a.png']);
        expect(refRows('d1')).toEqual([]);
    });
});

describe('snapshotRefsForDocuments', () => {
    it('多 doc 并集去重；空数组 → []', async () => {
        mkUser('u1');
        const a = await mkReadyImage('u1', 'a.png', pngBytes(1));
        const b = await mkReadyImage('u1', 'b.png', pngBytes(2));
        mkDoc('d1', 'u1');
        mkDoc('d2', 'u1');
        registerDocumentRefs('u1', 'd1', '![a](a.png) ![b](b.png)');
        registerDocumentRefs('u1', 'd2', '![a](a.png)');
        expect(snapshotRefsForDocuments(['d1', 'd2']).sort()).toEqual([a, b].sort());
        expect(snapshotRefsForDocuments([])).toEqual([]);
    });
});

describe('runImageGcCycle（周期回收，spec §9.3）', () => {
    it('pending 超 1h：物理删行 + blob 删；未超时不动', async () => {
        mkUser('u1');
        const stale = await mkPendingImage('u1', 'stale.png', pngBytes(1));
        const fresh = await mkPendingImage('u1', 'fresh.png', pngBytes(2));
        sqlite.exec(`UPDATE images SET created_at=0 WHERE id='${stale}'`);
        const r = await runImageGcCycle();
        await flush();
        expect(r.pendingReaped).toBe(1);
        expect(imageRow(stale)).toBeUndefined();          // 物理删（行消失）
        expect(imageRow(fresh)!.status).toBe('pending');  // 未超时不动
    });

    it('ready 无 refs 超 24h：软删 + blob 删；有 refs 不动', async () => {
        mkUser('u1');
        const orphan = await mkReadyImage('u1', 'orphan.png', pngBytes(1));
        const kept = await mkReadyImage('u1', 'kept.png', pngBytes(2));
        mkDoc('d1', 'u1');
        registerDocumentRefs('u1', 'd1', '![k](kept.png)');
        sqlite.exec(`UPDATE images SET ready_at=0 WHERE id IN ('${orphan}', '${kept}')`);
        const r = await runImageGcCycle();
        await flush();
        expect(r.readyReaped).toBe(1);
        expect(imageRow(orphan)!.status).toBe('deleted');
        expect(fs.existsSync(blobPath(orphan))).toBe(false);
        expect(imageRow(kept)!.status).toBe('ready');     // 有 ref → 不动
        expect(fs.existsSync(blobPath(kept))).toBe(true);
    });

    it('悬空 ref（指向非 ready 行）→ 清理', async () => {
        mkUser('u1');
        const dead = await mkReadyImage('u1', 'dead.png', pngBytes(1));
        sqlite.exec(`UPDATE images SET status='deleted' WHERE id='${dead}'`);
        mkDoc('d1', 'u1');
        sqlite.exec(`INSERT INTO image_refs (document_id, image_id, created_at) VALUES ('d1', '${dead}', 0)`);
        const r = await runImageGcCycle();
        expect(r.danglingRefs).toBe(1);
        expect(db.select().from(schema.imageRefs).all()).toEqual([]);
    });

    it('P1-3 顺序验证：悬空 ref 指向超时 pending 行 → 先清 ref 后删行（不抛 FK 错且行被物理删）', async () => {
        mkUser('u1');
        const p = await mkPendingImage('u1', 'p.png', pngBytes(1));
        mkDoc('d1', 'u1');
        sqlite.exec(`INSERT INTO image_refs (document_id, image_id, created_at) VALUES ('d1', '${p}', 0)`);
        sqlite.exec(`UPDATE images SET created_at=0 WHERE id='${p}'`);
        // 若删除先于 ref 清理：image_refs.image_id FK（no action + foreign_keys=ON）会让物理删行抛
        // SQLITE_CONSTRAINT_FOREIGNKEY 中断整轮——此处不抛即"先清后删"的证据
        const r = await runImageGcCycle();
        expect(r.danglingRefs).toBe(1);
        expect(r.pendingReaped).toBe(1);
        expect(imageRow(p)).toBeUndefined();
    });

    it('单轮清空：600 个超时 pending → 一轮全清（吞吐追平 init 产速，交叉审查 P1）', async () => {
        mkUser('u1');
        for (let i = 0; i < 600; i++) await mkPendingImage('u1', `p${i}.png`, uniqPng(i));
        sqlite.exec(`UPDATE images SET created_at=0 WHERE status='pending'`);
        const r = await runImageGcCycle();
        await flush();
        expect(r.pendingReaped).toBe(600);
        expect(db.select().from(schema.images).where(eq(schema.images.status, 'pending')).all()).toHaveLength(0);
    });

    it('单轮清空：600 个超时无 refs ready → 一轮全软删', async () => {
        mkUser('u1');
        for (let i = 0; i < 600; i++) await mkReadyImage('u1', `r${i}.png`, uniqPng(i));
        sqlite.exec(`UPDATE images SET ready_at=0 WHERE status='ready'`);
        const r = await runImageGcCycle();
        await flush();
        expect(r.readyReaped).toBe(600);
        expect(db.select().from(schema.images).where(eq(schema.images.status, 'ready')).all()).toHaveLength(0);
    });

    it('条件式：快照候选刚转 ready（created_at 超时但已转正）→ DELETE WHERE status=pending 0 行 → 行保留', async () => {
        mkUser('u1');
        const raced = await mkPendingImage('u1', 'raced.png', pngBytes(1));
        sqlite.exec(`UPDATE images SET created_at=0 WHERE id='${raced}'`);
        await relayImage('u1', raced, pngBytes(1)); // 转正（created_at 不随 relay 改，仍 0）
        const r = await runImageGcCycle();
        expect(r.pendingReaped).toBe(0);
        expect(imageRow(raced)!.status).toBe('ready'); // 快照 status 条件 + 删除 status 条件双重拦下
    });
});
