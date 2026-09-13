<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { parseThemePref, resolveTheme, cycleTheme, type ThemePref, THEME_STORAGE_KEY } from '$lib/shared/theme';

    let pref = $state<ThemePref>('auto');
    let effective = $state<'light' | 'dark'>('light');
    let observer: MutationObserver | null = null;
    let mq: MediaQueryList | null = null;
    let onSystemChange: (() => void) | null = null;

    function prefersDark(): boolean {
        return typeof window.matchMedia === 'function'
            && window.matchMedia('(prefers-color-scheme: dark)').matches;
    }

    function apply(): void {
        effective = resolveTheme(pref, prefersDark());
        document.documentElement.dataset.theme = effective;
    }

    function onClick(): void {
        pref = cycleTheme(pref);
        try {
            localStorage.setItem(THEME_STORAGE_KEY, pref);
        } catch (e) {
            // 隐私模式等写入失败，忽略：DOM 已更新，本次会话仍生效
        }
        apply();
    }

    onMount(() => {
        try {
            pref = parseThemePref(localStorage.getItem(THEME_STORAGE_KEY));
        } catch (e) {
            pref = 'auto';
        }
        apply();
        // 多实例/外部改动同步（如 dev 时 HMR）
        observer = new MutationObserver(() => {
            effective = document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
        });
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
        // auto 档：系统切换实时跟随
        if (typeof window.matchMedia === 'function') {
            mq = window.matchMedia('(prefers-color-scheme: dark)');
            onSystemChange = () => {
                if (pref === 'auto') apply();
            };
            mq.addEventListener('change', onSystemChange);
        }
    });
    onDestroy(() => {
        observer?.disconnect();
        if (mq && onSystemChange) mq.removeEventListener('change', onSystemChange);
    });

    const LABELS = {
        light: '主题：浅色',
        dark: '主题：深色'
    };

    // auto 档标签携带当前生效主题（effective 由 MutationObserver 同步，外部改动也响应）
    const label = $derived(
        pref === 'auto'
            ? `主题：自动（当前${effective === 'dark' ? '深色' : '浅色'}）`
            : LABELS[pref]
    );
</script>

<button
    type="button"
    class="rr-theme-toggle"
    onclick={onClick}
    aria-label="{label}，点击切换"
    title="{label}，点击切换"
>
    {#if pref === 'auto'}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3a9 9 0 0 1 0 18Z" fill="currentColor" stroke="none" />
        </svg>
    {:else if pref === 'dark'}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <circle cx="12" cy="12" r="4.2" />
            <path d="M12 2v2.5M12 19.5V22M2 12h2.5M19.5 12H22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
        </svg>
    {:else}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z" />
        </svg>
    {/if}
</button>

<style>
    .rr-theme-toggle {
        width: 32px;
        height: 32px;
        border-radius: 8px;
        border: 1px solid var(--rr-border, #d0d7de);
        background: var(--rr-toggle-bg, #eaeef1);
        color: var(--rr-text-muted, #57606a);
        display: inline-flex;
        align-items: center;
        justify-content: center;
        cursor: pointer;
        padding: 0;
    }
    .rr-theme-toggle:hover {
        color: var(--rr-text, #1f2328);
    }
</style>
