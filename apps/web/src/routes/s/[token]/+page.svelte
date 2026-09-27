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
        {#if data.ownerView}
            <a class="back" href="/">← 返回我的文档库</a>
        {:else}
            <!-- 匿名阅读者（IM 链接点击者）没有「我的文档库」——错误文案 + 登录墙（R-03）；
                 占位空节点维持 space-between 让主题切换恒居右 -->
            <span></span>
        {/if}
        <ThemeToggle />
    </div>
    {#await data.html}
        <!-- R-19：冷文档同步拉取期间页面级反馈（热文档同步字符串直落 then 分支零感知） -->
        <div class="doc-loading" role="status">
            <span class="spinner" aria-hidden="true"></span>
            文档正在从归档存储取回，稍候…
        </div>
    {:then html}
        <MarkdownViewer {html} />
    {:catch}
        <div class="doc-loading doc-loading-error" role="alert">文档取回失败（内容缺失或归档存储暂时不可达），请刷新重试</div>
    {/await}
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

    /* R-19 冷文档取回骨架屏 */
    .doc-loading {
        max-width: 960px;
        margin: 0 auto;
        padding: 4rem 2rem;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        color: var(--rr-text-muted);
        font-size: 0.95rem;
    }
    .doc-loading .spinner {
        width: 18px;
        height: 18px;
        border: 2px solid var(--rr-border);
        border-top-color: var(--rr-text);
        border-radius: 50%;
        animation: rr-doc-loading-spin 0.8s linear infinite;
        flex-shrink: 0;
    }
    .doc-loading-error { color: var(--rr-danger); }
    @keyframes rr-doc-loading-spin { to { transform: rotate(360deg); } }
</style>
