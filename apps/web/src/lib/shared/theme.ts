export type Theme = 'light' | 'dark';

export const THEME_STORAGE_KEY = 'rr-theme';

export function resolveTheme(stored: string | null, prefersDark: boolean): Theme {
    if (stored === 'light' || stored === 'dark') return stored;
    return prefersDark ? 'dark' : 'light';
}

export function toggleTheme(current: Theme): Theme {
    return current === 'dark' ? 'light' : 'dark';
}
