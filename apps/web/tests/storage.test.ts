import { test, expect, afterEach } from 'vitest';
import { rmSync, readdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeFile, readFile, FileNotFoundError } from '../src/lib/server/storage';

// mkdtemp 实例唯一：固定名在两个并发 vitest 实例同时跑本文件时会互删对方文件（本次审查残留面）
const TMP = mkdtempSync(join(tmpdir(), 'rr-storage-'));

afterEach(() => {
    try {
        rmSync(TMP, { recursive: true, force: true });
    } catch {}
});

test('writeFile 后 readFile 内容一致', async () => {
    await writeFile(`${TMP}/x.md`, '# hello');
    expect(await readFile(`${TMP}/x.md`)).toBe('# hello');
});

test('writeFile 自动创建父目录', async () => {
    await writeFile(`${TMP}/sub/dir/y.md`, 'nested');
    expect(await readFile(`${TMP}/sub/dir/y.md`)).toBe('nested');
});

test('writeFile 覆盖已有文件', async () => {
    await writeFile(`${TMP}/y.md`, 'v1');
    await writeFile(`${TMP}/y.md`, 'v2');
    expect(await readFile(`${TMP}/y.md`)).toBe('v2');
});

test('writeFile 原子性：成功后无 .tmp 残留（H1）', async () => {
    await writeFile(`${TMP}/atomic.md`, 'content');
    const files = readdirSync(TMP);
    expect(files.some((f) => f.includes('.tmp.'))).toBe(false);
    expect(files).toContain('atomic.md');
});

test('writeFile 覆盖后旧文件完整替换、无 tmp 残留（H1）', async () => {
    await writeFile(`${TMP}/ovr.md`, 'first');
    await writeFile(`${TMP}/ovr.md`, 'second');
    expect(await readFile(`${TMP}/ovr.md`)).toBe('second');
    const matched = readdirSync(TMP).filter((f) => f === 'ovr.md' || f.startsWith('ovr.md.'));
    expect(matched).toEqual(['ovr.md']);
});

test('readFile 不存在的文件抛 FileNotFoundError（M11）', async () => {
    await expect(readFile(`${TMP}/nope.md`)).rejects.toBeInstanceOf(FileNotFoundError);
});

test('接近 NAME_MAX 的长文件名可正常写入（tmp 固定短名不叠加原名）', async () => {
    const longName = 'a'.repeat(250) + '.md'; // 254B ≤ 255B 合法
    await writeFile(`${TMP}/${longName}`, 'content');
    expect(await readFile(`${TMP}/${longName}`)).toBe('content');
    const files = readdirSync(TMP);
    expect(files.some((f) => f.startsWith('.tmp.'))).toBe(false);
});
