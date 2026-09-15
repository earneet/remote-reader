<script lang="ts">
    // 登录/注册共用的认证卡片（A-5：两页 ~130 行样式逐字重复的收敛）。
    // 表单控件样式用 .card :global(...) 圈定——snippet 内容编译于父组件作用域，
    // scoped 样式够不到；限定在 .card 内则不会泄漏到页面其他部分
    import type { Snippet } from 'svelte';

    let {
        title,
        error,
        children,
        footer
    }: {
        title: string;
        error?: string;
        children: Snippet;
        footer?: Snippet;
    } = $props();
</script>

<div class="auth-page">
    <div class="card">
        <div class="brand">
            <svg
                width="24"
                height="24"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="2"
                stroke-linecap="round"
                stroke-linejoin="round"
                aria-hidden="true"
            >
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                <polyline points="14 2 14 8 20 8" />
                <line x1="8" y1="13" x2="16" y2="13" />
                <line x1="8" y1="17" x2="13" y2="17" />
            </svg>
            <span class="brand-name">Remote Reader</span>
        </div>

        <h1 class="title">{title}</h1>

        {#if error}
            <div class="alert" role="alert">{error}</div>
        {/if}

        {@render children()}

        <p class="footer">{@render footer?.()}</p>
    </div>
</div>

<style>
    .auth-page {
        min-height: 100vh;
        display: flex;
        align-items: center;
        justify-content: center;
        background: var(--rr-bg);
        font-family: system-ui, -apple-system, sans-serif;
        padding: 1rem;
    }

    .card {
        width: min(380px, calc(100vw - 2rem));
        background: var(--rr-card-bg);
        border: 1px solid var(--rr-card-border);
        border-radius: 12px;
        box-shadow: var(--rr-shadow);
        padding: 2.5rem;
        box-sizing: border-box;
    }

    .brand {
        display: flex;
        align-items: center;
        justify-content: center;
        gap: 0.5rem;
        margin-bottom: 1.5rem;
        color: var(--rr-accent);
    }

    .brand-name {
        font-size: 1.25rem;
        font-weight: 600;
        color: var(--rr-text);
    }

    .title {
        margin: 0 0 0.5rem;
        text-align: center;
        font-size: 1.5rem;
        font-weight: 600;
        color: var(--rr-text);
    }

    .alert {
        margin: 0;
        background: var(--rr-danger-soft);
        border: 1px solid var(--rr-danger-border);
        border-radius: 6px;
        padding: 0.6rem 0.75rem;
        color: var(--rr-danger);
        font-size: 0.9rem;
    }

    .card :global(form) {
        display: flex;
        flex-direction: column;
        gap: 1rem;
        margin-top: 1rem;
    }

    .card :global(.field) {
        display: flex;
        flex-direction: column;
    }

    .card :global(label) {
        display: block;
        font-size: 0.875rem;
        font-weight: 500;
        color: var(--rr-text);
        margin-bottom: 0.375rem;
    }

    .card :global(input) {
        width: 100%;
        padding: 0.6rem 0.75rem;
        border: 1px solid var(--rr-input-border);
        border-radius: 6px;
        font-size: 0.95rem;
        box-sizing: border-box;
        background: var(--rr-input-bg);
        color: var(--rr-text);
        font-family: inherit;
    }

    .card :global(input:focus) {
        outline: none;
        border-color: var(--rr-accent);
        box-shadow: 0 0 0 3px var(--rr-focus-ring);
    }

    .card :global(.submit) {
        width: 100%;
        margin-top: 1.25rem;
        padding: 0.65rem 1rem;
        background: var(--rr-accent);
        color: var(--rr-btn-primary-text);
        border: none;
        border-radius: 6px;
        font-size: 0.95rem;
        font-weight: 500;
        cursor: pointer;
        font-family: inherit;
    }

    .card :global(.submit:hover) {
        background: var(--rr-accent-hover);
    }

    .card :global(.submit:disabled) {
        opacity: 0.6;
        cursor: not-allowed;
    }

    .footer {
        margin-top: 1.25rem;
        text-align: center;
        font-size: 0.875rem;
        color: var(--rr-text-muted);
    }

    .footer :global(a) {
        color: var(--rr-link);
        text-decoration: none;
    }

    .footer :global(a:hover) {
        text-decoration: underline;
    }
</style>
