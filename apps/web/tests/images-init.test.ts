import { describe, it, expect, beforeEach, afterAll } from 'vitest';
import { db, schema, sqlite } from '$server/db';
import { resetDb } from './helpers';
import { initImage, type InitImageResult } from '$server/images';
import { eq } from 'drizzle-orm';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'rr-imginit-'));
process.env.DATA_DIR = DIR;
afterAll(() => { delete process.env.DATA_DIR; fs.rmSync(DIR, { recursive: true, force: true }); });

beforeEach(() => resetDb());

function mkUser(id: string): void {
    sqlite.exec(`INSERT INTO users (id, email, password_hash, role, created_at) VALUES ('${id}', '${id}@t.local', 'x', 'member', 0)`);
}
// exists 分支会 head 探测 blob（自愈）——种子行必须落真实 blob 才是健康 ready 态
function mkReadyImage(ownerId: string, name: string, hash: string): string {
    const id = `img-${hash.slice(0, 8)}`;
    const key = `${ownerId}/blobs/${hash.slice(0, 2)}/${hash}`;
    fs.mkdirSync(path.dirname(path.join(DIR, ...key.split('/'))), { recursive: true });
    fs.writeFileSync(path.join(DIR, ...key.split('/')), Buffer.alloc(10, 1));
    sqlite.exec(`INSERT INTO images (id, owner_id, name, content_hash, content_md5, mime_type, size_bytes, status, storage_backend, storage_key, created_at, ready_at)
        VALUES ('${id}', '${ownerId}', '${name}', '${hash}', '${'m'.repeat(32)}', 'image/png', 10, 'ready', 'local', '${key}', 0, 0)`);
    return id;
}

// InitImageResult 联合中 exists 分支无 imageId——统一从这取（narrow 后类型安全）
function idOf(r: InitImageResult): string {
    if (r.status === 'exists') throw new Error(`期望 relay/direct，实际 exists（name=${r.name}）`);
    return r.imageId;
}

describe('initImage 四分支（spec §5.1）', () => {
    it('新图：插 pending 行，local 后端返回 relay', async () => {
        mkUser('u1');
        const r = await initImage('u1', { name: 'shot.png', contentHash: 'a'.repeat(64), contentMd5: 'b'.repeat(32), sizeBytes: 100 });
        expect(r.status).toBe('relay');
        expect(r.name).toBe('shot.png');
        const row = db.select().from(schema.images).where(eq(schema.images.id, idOf(r))).get();
        expect(row?.status).toBe('pending');
        expect(row?.storageBackend).toBe('local');
    });
    it('exists：同 owner 同 hash ready 行 → 零流量复用注册名', async () => {
        mkUser('u1');
        mkReadyImage('u1', 'old-name.png', 'c'.repeat(64));
        const r = await initImage('u1', { name: 'new-name.png', contentHash: 'c'.repeat(64), contentMd5: 'd'.repeat(32), sizeBytes: 100 });
        expect(r).toEqual({ status: 'exists', name: 'old-name.png' });
    });
    it('pending 共享：同 hash pending 行 → 同 image_id 复用（不插新行）', async () => {
        mkUser('u1');
        const first = await initImage('u1', { name: 'a.png', contentHash: 'e'.repeat(64), contentMd5: 'f'.repeat(32), sizeBytes: 1 });
        const second = await initImage('u1', { name: 'b.png', contentHash: 'e'.repeat(64), contentMd5: 'f'.repeat(32), sizeBytes: 1 });
        expect(idOf(second)).toBe(idOf(first));
        expect(second.name).toBe('a.png'); // 响应返回行内注册名（spec #2 唯一权威）
    });
    it('墓碑复活：同名重传沿用原名（P0-1）+ 全字段重置', async () => {
        mkUser('u1');
        const id = mkReadyImage('u1', 'tomb.png', '9'.repeat(64));
        sqlite.exec(`UPDATE images SET status='deleted', ready_at=5 WHERE id='${id}'`);
        const r = await initImage('u1', { name: 'tomb.png', contentHash: '9'.repeat(64), contentMd5: '8'.repeat(32), sizeBytes: 7 });
        expect(r.status).toBe('relay');
        const row = db.select().from(schema.images).where(eq(schema.images.id, id)).get();
        expect(row?.status).toBe('pending');
        expect(row?.name).toBe('tomb.png'); // ← P0-1 关键断言：不得被自身占名强制改成 tomb-2.png
        expect(row?.readyAt).toBeNull();
        expect(row?.sizeBytes).toBe(7);
        expect(row?.contentMd5).toBe('8'.repeat(32));
    });
    it('墓碑别名重传：请求名 != 行名 → 分配新名且不被墓碑旧名挤占', async () => {
        mkUser('u1');
        const id = mkReadyImage('u1', 'tomb.png', '9'.repeat(64));
        sqlite.exec(`UPDATE images SET status='deleted' WHERE id='${id}'`);
        const r = await initImage('u1', { name: 'fresh.png', contentHash: '9'.repeat(64), contentMd5: '8'.repeat(32), sizeBytes: 7 });
        expect(r.name).toBe('fresh.png');
    });
    it('同名不同内容：自动后缀 -2..-N（精确探测，跨墓碑也占位）', async () => {
        mkUser('u1');
        mkReadyImage('u1', 'shot.png', '1'.repeat(64));
        const r = await initImage('u1', { name: 'shot.png', contentHash: '2'.repeat(64), contentMd5: '3'.repeat(32), sizeBytes: 1 });
        expect(r.name).toBe('shot-2.png');
    });
    it('hash/md5 格式校验（P0-1）：非法 → throw（路由层转 400，防 storage_key 路径穿越）', async () => {
        mkUser('u1');
        await expect(initImage('u1', { name: 'a.png', contentHash: '../../evil', contentMd5: 'x'.repeat(32), sizeBytes: 1 })).rejects.toThrow(/content_hash/);
        await expect(initImage('u1', { name: 'a.png', contentHash: 'a'.repeat(64), contentMd5: 'zz', sizeBytes: 1 })).rejects.toThrow(/content_md5/);
    });
    it('超限 413 / 非法名 400（单段语义）', async () => {
        mkUser('u1');
        await expect(initImage('u1', { name: 'a.png', contentHash: 'a'.repeat(64), contentMd5: 'b'.repeat(32), sizeBytes: 11 * 1024 * 1024 })).rejects.toThrow(/上限/);
        await expect(initImage('u1', { name: 'a/b.png', contentHash: 'a'.repeat(64), contentMd5: 'b'.repeat(32), sizeBytes: 1 })).rejects.toThrow(/name/);
    });
    it('owner 隔离：他 owner 的同 hash 行不命中 exists', async () => {
        mkUser('u1'); mkUser('u2');
        mkReadyImage('u2', 'x.png', '7'.repeat(64));
        const r = await initImage('u1', { name: 'x.png', contentHash: '7'.repeat(64), contentMd5: '6'.repeat(32), sizeBytes: 1 });
        expect(r.status).toBe('relay');
    });
});
