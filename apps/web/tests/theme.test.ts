import { test, expect } from 'vitest';
import { resolveTheme, toggleTheme, THEME_STORAGE_KEY } from '../src/lib/shared/theme';

test('resolveTheme: stored 合法值优先', () => {
    expect(resolveTheme('dark', false)).toBe('dark');
    expect(resolveTheme('light', true)).toBe('light');
});

test('resolveTheme: 无 stored 时跟随系统', () => {
    expect(resolveTheme(null, true)).toBe('dark');
    expect(resolveTheme(null, false)).toBe('light');
});

test('resolveTheme: stored 非法值回退到系统', () => {
    expect(resolveTheme('garbage', true)).toBe('dark');
    expect(resolveTheme('', false)).toBe('light');
});

test('toggleTheme: 双向切换', () => {
    expect(toggleTheme('dark')).toBe('light');
    expect(toggleTheme('light')).toBe('dark');
});

test('THEME_STORAGE_KEY 为约定键名', () => {
    expect(THEME_STORAGE_KEY).toBe('rr-theme');
});
