import { test, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';

// 读失败分支注入：version.ts 只依赖 readFileSync，mock 单一入口不影响其他 fs 能力
vi.mock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>();
    return { ...actual, readFileSync: vi.fn(actual.readFileSync) };
});

const { getBridgeVersion } = await import('../src/version');

test('getBridgeVersion 读取 package.json 的 version（0.2.0 起，源码/打包两形态同源）', () => {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version: string };
    expect(getBridgeVersion()).toBe(pkg.version);
});

test('读失败/解析失败 → 兜底 0.0.0 + stderr 记录原因（不污染 MCP stdio 通道）', () => {
    vi.mocked(readFileSync).mockImplementationOnce(() => {
        throw new Error('boom');
    });
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
        expect(getBridgeVersion()).toBe('0.0.0');
        expect(err).toHaveBeenCalledTimes(1);
        expect(err).toHaveBeenCalledWith('[remote-reader] 读取桥版本失败，按 0.0.0 处理');
    } finally {
        err.mockRestore();
    }
});
