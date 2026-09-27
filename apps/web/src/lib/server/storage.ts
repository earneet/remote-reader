import { mkdir, writeFile as fsWrite, readFile as fsRead, rename, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export class FileNotFoundError extends Error {
    readonly code = 'FILE_NOT_FOUND' as const;
    constructor(path: string) {
        super(`file not found: ${path}`);
        this.name = 'FileNotFoundError';
    }
}

// 递归 mkdir 的并发删除竞态重试（R-28 引入 deleteNode 空目录回收后成为真实交错）：
// node 的 recursive mkdir 在「父链确认与最终 mkdir 之间目标目录被并发 rmdir」时可能误报
// ENOENT（父目录实际存在）——重试一次即成功，窗口极窄无活锁风险
async function mkdirDirRaceSafe(dir: string): Promise<void> {
    try {
        await mkdir(dir, { recursive: true });
    } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
            await mkdir(dir, { recursive: true });
        } else {
            throw e;
        }
    }
}

// H1: 原子写——先写同目录 .tmp 再 rename（同目录即同 fs，rename 原子）。
// 写中途崩溃/断电不会损坏已有文件：旧文件在 rename 成功前完整保留。
// tmp 用固定长度短名而非叠加在原名上：单段名允许到 255B（NAME_MAX），
// `${path}.tmp.` 会再加 17B 击穿上限使合法长名上传 ENAMETOOLONG 500。
// 写入/改名任一失败都清理 tmp（磁盘满时半写文件不残留累积）。
export async function writeFile(path: string, content: string): Promise<void> {
    await mkdirDirRaceSafe(dirname(path));
    const tmp = join(dirname(path), `.tmp.${randomBytes(6).toString('hex')}`);
    try {
        await fsWrite(tmp, content, 'utf-8');
        await rename(tmp, path);
    } catch (e) {
        try {
            await unlink(tmp);
        } catch {}
        throw e;
    }
}

export async function readFile(path: string): Promise<string> {
    try {
        return await fsRead(path, 'utf-8');
    } catch (e) {
        // M11: 磁盘文件丢失 → 明确 NotFound，路由层转 404 而非裸 500
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') throw new FileNotFoundError(path);
        throw e;
    }
}
