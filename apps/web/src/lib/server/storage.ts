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

// H1: 原子写——先写同目录 .tmp 再 rename（同目录即同 fs，rename 原子）。
// 写中途崩溃/断电不会损坏已有文件：旧文件在 rename 成功前完整保留。
// tmp 用固定长度短名而非叠加在原名上：单段名允许到 255B（NAME_MAX），
// `${path}.tmp.` 会再加 17B 击穿上限使合法长名上传 ENAMETOOLONG 500。
// 写入/改名任一失败都清理 tmp（磁盘满时半写文件不残留累积）。
export async function writeFile(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
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
