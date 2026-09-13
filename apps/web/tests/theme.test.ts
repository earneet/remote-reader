import { test, expect } from 'vitest';
import {
    resolveTheme,
    parseThemePref,
    cycleTheme,
    THEME_STORAGE_KEY
} from '../src/lib/shared/theme';
import type { ThemePref } from '../src/lib/shared/theme';

test('parseThemePref: 合法值直通', () => {
    expect(parseThemePref('light')).toBe('light');
    expect(parseThemePref('dark')).toBe('dark');
    expect(parseThemePref('auto')).toBe('auto');
});

test('parseThemePref: 非法/缺失回退 auto（兼容旧两值存储）', () => {
    expect(parseThemePref(null)).toBe('auto');
    expect(parseThemePref('garbage')).toBe('auto');
    expect(parseThemePref('')).toBe('auto');
});

test('resolveTheme: 显式偏好直通', () => {
    expect(resolveTheme('light', true)).toBe('light');
    expect(resolveTheme('dark', false)).toBe('dark');
});

test('resolveTheme: auto 跟随系统', () => {
    expect(resolveTheme('auto', true)).toBe('dark');
    expect(resolveTheme('auto', false)).toBe('light');
});

test('cycleTheme: auto → light → dark → auto 循环', () => {
    let pref: ThemePref = 'auto';
    const seq: ThemePref[] = [];
    for (let i = 0; i < 3; i++) {
        pref = cycleTheme(pref);
        seq.push(pref);
    }
    expect(seq).toEqual(['light', 'dark', 'auto']);
});

test('THEME_STORAGE_KEY 为约定键名', () => {
    expect(THEME_STORAGE_KEY).toBe('rr-theme');
});
