<script lang="ts">
    import { page } from '$app/state';
    import ThemeToggle from '$components/ThemeToggle.svelte';

    const hint = $derived(
        page.status === 404
            ? '链接可能已失效或内容不存在（分享链接被撤销后会立即失效）'
            : page.status === 503
                ? '归档存储暂时不可达，稍后刷新重试'
                : page.status === 403
                    ? '没有权限执行该操作'
                    : '服务出现了一点问题，请刷新重试'
    );
</script>

<svelte:head>
    <title>{page.status} · Remote Reader</title>
</svelte:head>

<div class="err-root">
    <div class="err-topbar"><ThemeToggle /></div>
    <div class="err-card">
        <p class="code">{page.status}</p>
        <h1>{page.error?.message ?? '出错了'}</h1>
        <p class="hint">{hint}</p>
        <div class="actions">
            <a class="btn primary" href="/">返回首页</a>
            <button type="button" class="btn" onclick={() => history.back()}>返回上一页</button>
        </div>
    </div>
</div>

<style>
    .err-root {
        min-height: 100vh;
        background: var(--rr-bg);
        color: var(--rr-text);
        font-family: system-ui, -apple-system, sans-serif;
    }
    .err-topbar {
        max-width: 960px;
        margin: 0 auto;
        padding: 1rem 2rem 0;
        display: flex;
        justify-content: flex-end;
        box-sizing: border-box;
    }
    .err-card {
        max-width: 560px;
        margin: 10vh auto 0;
        padding: 2rem;
        text-align: center;
        box-sizing: border-box;
    }
    .code {
        margin: 0;
        font-size: 4rem;
        font-weight: 700;
        line-height: 1;
        color: var(--rr-text-muted);
        font-variant-numeric: tabular-nums;
    }
    h1 {
        margin: 0.75rem 0 0.5rem;
        font-size: 1.25rem;
    }
    .hint {
        margin: 0 0 1.5rem;
        color: var(--rr-text-muted);
        font-size: 0.95rem;
    }
    .actions {
        display: flex;
        gap: 0.75rem;
        justify-content: center;
    }
    .btn {
        display: inline-block;
        padding: 0.45rem 1rem;
        border: 1px solid var(--rr-btn-border);
        border-radius: 6px;
        background: var(--rr-btn-bg);
        color: var(--rr-btn-text);
        font-size: 0.9rem;
        text-decoration: none;
        cursor: pointer;
    }
    .btn.primary {
        background: var(--rr-btn-primary-bg);
        color: var(--rr-btn-primary-text);
        border-color: var(--rr-btn-primary-bg);
    }
    @media (max-width: 768px) {
        .err-topbar { padding: 1rem 1rem 0; }
        .err-card { padding: 1rem; }
    }
</style>
