<script lang="ts">
    import { onMount, onDestroy } from 'svelte';
    import { toggleTheme, type Theme, THEME_STORAGE_KEY } from '$lib/shared/theme';

    let current = $state<Theme>('light');
    let observer: MutationObserver | null = null;

    function readCurrent(): Theme {
        return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
    }

    function onClick(): void {
        const next = toggleTheme(current);
        document.documentElement.dataset.theme = next;
        try {
            localStorage.setItem(THEME_STORAGE_KEY, next);
        } catch (e) {
            // 隐私模式等写入失败，忽略：DOM 已更新，本次会话仍生效
        }
        current = next;
    }

    onMount(() => {
        current = readCurrent();
        observer = new MutationObserver(() => {
            current = readCurrent();
        });
        observer.observe(document.documentElement, {
            attributes: true,
            attributeFilter: ['data-theme']
        });
    });
    onDestroy(() => observer?.disconnect());
</script>

<button
    type="button"
    class="rr-theme-toggle"
    onclick={onClick}
    aria-label="切换深浅色主题"
    title={current === 'dark' ? '切换到浅色' : '切换到深色'}
>
    {#if current === 'dark'}
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
