import { test, expect } from 'vitest';
import { formatRelative } from '../src/lib/shared/time';

const NOW = 1_700_000_000_000;

test('刚刚：diff < 60s', () => {
    expect(formatRelative(NOW - 59_000, NOW)).toBe('刚刚');
    expect(formatRelative(NOW, NOW)).toBe('刚刚');
});

test('分钟前：60s ≤ diff < 60m', () => {
    expect(formatRelative(NOW - 60_000, NOW)).toBe('1 分钟前');
    expect(formatRelative(NOW - 59 * 60_000, NOW)).toBe('59 分钟前');
});

test('小时前：60m ≤ diff < 24h', () => {
    expect(formatRelative(NOW - 60 * 60_000, NOW)).toBe('1 小时前');
    expect(formatRelative(NOW - 23 * 3_600_000, NOW)).toBe('23 小时前');
});

test('天前：24h ≤ diff < 7d', () => {
    expect(formatRelative(NOW - 24 * 3_600_000, NOW)).toBe('1 天前');
    expect(formatRelative(NOW - (7 * 86_400_000 - 1), NOW)).toBe('6 天前');
});

test('日期：diff ≥ 7d 显示 YYYY-MM-DD（本地时间构造，时区无关）', () => {
    const past = new Date(2024, 0, 5, 12, 0, 0).getTime(); // 本地 2024-01-05 正午
    const now = past + 8 * 86_400_000;
    expect(formatRelative(past, now)).toBe('2024-01-05');
});

test('未来时间戳（负 diff）→ 刚刚（时钟偏差优雅降级）', () => {
    expect(formatRelative(NOW + 5_000, NOW)).toBe('刚刚');
});

test('恰好 7d 整 → 日期分支', () => {
    expect(formatRelative(NOW - 7 * 86_400_000, NOW)).toBe(
        `${new Date(NOW - 7 * 86_400_000).getFullYear()}-` +
        `${String(new Date(NOW - 7 * 86_400_000).getMonth() + 1).padStart(2, '0')}-` +
        `${String(new Date(NOW - 7 * 86_400_000).getDate()).padStart(2, '0')}`
    );
});
