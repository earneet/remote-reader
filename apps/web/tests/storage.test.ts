import { test, expect, afterEach } from 'bun:test';
import { rmSync, existsSync } from 'node:fs';
import { writeFile, readFile, ensureDir } from '../src/lib/server/storage';

const TMP = './data/test-storage';

afterEach(() => {
    try {
        rmSync(TMP, { recursive: true, force: true });
    } catch {}
});

test('ensureDir 创建多级目录', () => {
    ensureDir(`${TMP}/a/b/c`);
    expect(existsSync(`${TMP}/a/b/c`)).toBe(true);
});

test('ensureDir 对已存在目录不报错（幂等）', () => {
    ensureDir(`${TMP}/x`);
    ensureDir(`${TMP}/x`);
    expect(existsSync(`${TMP}/x`)).toBe(true);
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
