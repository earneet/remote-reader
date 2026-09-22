import { test, expect } from 'vitest';
import { compareVersions } from './semver';

test('相等 → 0', () => {
    expect(compareVersions('0.2.0', '0.2.0')).toBe(0);
    expect(compareVersions('1.0.0', '1.0.0')).toBe(0);
});

test('小于 → -1', () => {
    expect(compareVersions('0.1.0', '0.2.0')).toBe(-1);
    expect(compareVersions('0.1.9', '0.2.0')).toBe(-1);
    expect(compareVersions('0.2.0', '1.0.0')).toBe(-1);
    expect(compareVersions('0.2.9', '0.2.10')).toBe(-1);
});

test('大于 → 1（数值比较非字典序：0.10 > 0.9）', () => {
    expect(compareVersions('0.2.0', '0.1.0')).toBe(1);
    expect(compareVersions('0.10.0', '0.9.0')).toBe(1);
    expect(compareVersions('1.0.0', '0.2.0')).toBe(1);
});

test('缺段按 0 计', () => {
    expect(compareVersions('0.2', '0.2.0')).toBe(0);
    expect(compareVersions('0.2.0', '0.2')).toBe(0);
    expect(compareVersions('1', '1.0.0')).toBe(0);
    expect(compareVersions('0.2.1', '0.2')).toBe(1);
    expect(compareVersions('0.2', '0.2.1')).toBe(-1);
});

test('非数字段按 0 计', () => {
    expect(compareVersions('0.2.0-beta', '0.2.0')).toBe(0);
    expect(compareVersions('x', '0')).toBe(0);
    expect(compareVersions('0.2.x', '0.2.0')).toBe(0);
    expect(compareVersions('0.3.x', '0.2.0')).toBe(1);
});
