<script lang="ts">
    import MarkdownViewer from '$components/MarkdownViewer.svelte';
    import ThemeToggle from '$components/ThemeToggle.svelte';
    let { data } = $props();
</script>

<svelte:head>
    <title>{data.title}</title>
</svelte:head>

<div class="share-root">
    <div class="share-topbar">
        <a class="back" href="/">← 返回我的文档库</a>
        <ThemeToggle />
    </div>
    <MarkdownViewer html={data.html} />
</div>

<style>
    .share-root {
        --rr-bg: #f6f8fa;
        --rr-card-bg: #ffffff;
        --rr-card-border: transparent;
        --rr-text: #1f2328;
        --rr-text-muted: #57606a;
        --rr-link: #0969da;
        --rr-border: #d0d7de;
        --rr-border-soft: #eaecef;
        --rr-inline-code-bg: #eff2f5;
        --rr-inline-code-text: #bc4b00;
        --rr-code-bg: #1e2228;
        --rr-shadow: 0 1px 3px rgba(0, 0, 0, 0.05), 0 10px 28px rgba(0, 0, 0, 0.06);
        --rr-toggle-bg: #eaeef1;
        min-height: 100vh;
        background: var(--rr-bg);
        color: var(--rr-text);
        color-scheme: light;
    }
    :global([data-theme="dark"]) .share-root {
        --rr-bg: #0d1117;
        --rr-card-bg: #161b22;
        --rr-card-border: #21262d;
        --rr-text: #c9d1d9;
        --rr-text-muted: #8b949e;
        --rr-link: #58a6ff;
        --rr-border: #21262d;
        --rr-border-soft: #21262d;
        --rr-inline-code-bg: rgba(110, 118, 129, 0.28);
        --rr-inline-code-text: #e3b341;
        --rr-code-bg: #0d1117;
        --rr-shadow: 0 10px 28px rgba(0, 0, 0, 0.45);
        --rr-toggle-bg: #21262d;
        color-scheme: dark;
    }
    .share-topbar {
        max-width: 960px;
        margin: 0 auto;
        padding: 1rem 2rem 0;
        display: flex;
        align-items: center;
        justify-content: space-between;
        box-sizing: border-box;
    }
    .back {
        color: var(--rr-link);
        text-decoration: none;
        font-size: 14px;
    }
    .back:hover {
        text-decoration: underline;
    }
    @media (max-width: 768px) {
        .share-topbar {
            padding: 1rem 1rem 0;
        }
    }
</style>
