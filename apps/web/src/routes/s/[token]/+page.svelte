<script lang="ts">
    import MarkdownViewer from '$components/MarkdownViewer.svelte';
    import ThemeToggle from '$components/ThemeToggle.svelte';
    import { reportView } from '$lib/shared/view-beacon';
    let { data } = $props();
    // 仅 owner 登录态上报（匿名访客不算浏览，spec §3 浏览口径）；服务端仍会校验 owner。
    // lastReported 守卫同 /d/ 页：invalidateAll 不误记、同路由参数切换（换 token）补记
    let lastReported = '';
    $effect(() => {
        if (data.ownerView && data.id !== lastReported) {
            lastReported = data.id;
            reportView(data.id);
        }
    });
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
        min-height: 100vh;
        background: var(--rr-bg);
        color: var(--rr-text);
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
