<script lang="ts">
    import MarkdownViewer from '$components/MarkdownViewer.svelte';
    import { enhance } from '$app/forms';
    import { invalidateAll } from '$app/navigation';
    import { reportView } from '$lib/shared/view-beacon';
    let { data, form } = $props();
    // 「最近浏览」上报（spec §7.1）：$effect 仅客户端执行——hover 预取只跑 load 不挂载组件，机制性排除；
    // lastReported 守卫：invalidateAll（setTags 后 data 重建、id 不变）不误记；
    // 同路由参数切换（/d/a→/d/b，如文档内 markdown 链接）id 变 → 补记（「打开即算一次」口径）
    let lastReported = '';
    $effect(() => {
        if (data.id !== lastReported) {
            lastReported = data.id;
            reportView(data.id);
        }
    });
    let editing = $state(false);
    // 草稿用 $state（F4）：$derived 受控值会在同路由参数切换时重算，静默清掉用户已输入的内容
    let tagInput = $state('');
    let tagError = $state<string | null>(null);
    // 随文档切换重置编辑态（/d/a→/d/b 组件复用，SvelteKit 不重建页面组件——
    // {#key} 只重建 DOM 不重置 script 层 $state，须显式归零，否则 A 的草稿会误写到 B）
    $effect(() => {
        data.id;
        editing = false;
        tagError = null;
    });
    function startEdit(): void {
        tagInput = data.tags.map(t => t.name).join(', ');
        tagError = null;
        editing = true;
    }
</script>

<svelte:head><title>{data.title}</title></svelte:head>

<a href="/" class="back">← 返回我的文档</a>

<div class="tag-bar">
    {#if !editing}
        {#each data.tags as t (t.id)}<span class="chip-static">{t.name}</span>{/each}
        <button class="btn sm" onclick={startEdit}>🏷 编辑标签</button>
        <!-- no-JS 原生提交时 fail() 经 SSR 重渲染以 form prop 送达（enhance 路径走 tagError） -->
        {#if form?.error}<span class="tag-error" role="alert">{form.error}</span>{/if}
    {:else}
        <form method="POST" action="?/setTags" use:enhance={() => async ({ result }) => {
            if (result.type === 'success') { editing = false; await invalidateAll(); }
            else if (result.type === 'failure') {
                tagError = String((result.data as { error?: string } | undefined)?.error ?? '保存失败，请重试');
            }
        }}>
            <input name="tags" value={tagInput} placeholder="逗号分隔" autofocus
                onkeydown={(e) => { if (e.key === 'Escape') editing = false; }}
                oninput={(e) => (tagInput = e.currentTarget.value)}>
            <button type="submit" class="btn sm primary">保存</button>
            <button type="button" class="btn sm" onclick={() => (editing = false)}>取消</button>
            {#if tagError}<span class="tag-error" role="alert">{tagError}</span>{/if}
        </form>
    {/if}
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

<style>
    .back { display: inline-block; max-width: 760px; margin: 0 auto; padding: 1rem 2rem 0; color: var(--rr-link); }
    .tag-bar { max-width: 760px; margin: 0 auto; padding: 0.5rem 2rem; display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
    .chip-static { display: inline-block; padding: 0 0.5rem; background: var(--rr-accent-soft); color: var(--rr-link); border-radius: 999px; font-size: 0.78rem; }
    .btn { border: 1px solid var(--rr-btn-border); background: var(--rr-btn-bg); color: var(--rr-btn-text); cursor: pointer; padding: 0.3rem 0.7rem; border-radius: 5px; font-size: 0.8rem; }
    .btn.sm { padding: 0.25rem 0.6rem; }
    .btn.primary { background: var(--rr-btn-primary-bg); color: var(--rr-btn-primary-text); border-color: var(--rr-btn-primary-bg); }
    .tag-bar input { padding: 0.25rem 0.5rem; border: 1px solid var(--rr-accent); border-radius: 5px; font-size: 0.82rem; min-width: 14rem; background: var(--rr-input-bg); color: var(--rr-text); }
    .tag-error { color: var(--rr-danger); font-size: 0.8rem; }

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
