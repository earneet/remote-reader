export type Theme = 'light' | 'dark';
export type ThemePref = 'auto' | 'light' | 'dark';

export const THEME_STORAGE_KEY = 'rr-theme';

// 旧版存储只有 light/dark 两值；缺失或非法一律视为 auto（跟随系统）
export function parseThemePref(stored: string | null): ThemePref {
    if (stored === 'light' || stored === 'dark' || stored === 'auto') return stored;
    return 'auto';
}

export function resolveTheme(pref: ThemePref, prefersDark: boolean): Theme {
    if (pref === 'light') return 'light';
    if (pref === 'dark') return 'dark';
    return prefersDark ? 'dark' : 'light';
}

export function cycleTheme(pref: ThemePref): ThemePref {
    return pref === 'auto' ? 'light' : pref === 'light' ? 'dark' : 'auto';
}

// 过渡期保留：Task 3 的 ThemeToggle 切换到 cycleTheme 后随同删除
export function toggleTheme(current: Theme): Theme {
    return current === 'dark' ? 'light' : 'dark';
}
