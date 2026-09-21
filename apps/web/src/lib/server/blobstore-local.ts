import { mkdir, readFile, stat, unlink, open, writeFile as fsWrite, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { getDataDir } from './env';
import { ObjectNotFoundError } from './object-store-errors';
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

    // contentType 参数仅为对齐 BlobStore 接口签名；local 布局不落盘 mime（元数据全在 DB 行），忽略之
    async put(key: string, data: Buffer, _contentType?: string): Promise<void> {
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

    async head(key: string): Promise<{ size: number; etag?: string }> {
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
