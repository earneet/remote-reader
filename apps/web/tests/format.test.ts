import { test, expect } from 'vitest';
import { formatBytes } from '../src/lib/shared/format';

test('formatBytes 各量级', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(2097152)).toBe('2 MB');
    expect(formatBytes(10 * 1024 * 1024)).toBe('10 MB');
    expect(formatBytes(3 * 1024 * 1024 * 1024)).toBe('3 GB');
    expect(formatBytes(5 * 1024 ** 4)).toBe('5 TB');
});

test('formatBytes 大值封顶 TB 单位不越界', () => {
    expect(formatBytes(1024 ** 6)).toBe('1048576 TB');
});
