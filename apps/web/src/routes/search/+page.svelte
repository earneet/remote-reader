<script lang="ts">
    import { goto } from '$app/navigation';
    let { data } = $props();
    const tags = $derived(data.allTags);
    let searchInput = $state<HTMLInputElement | null>(null);
    function toggleTag(name: string): string[] {
        return data.selectedTags.includes(name)
            ? data.selectedTags.filter((t: string) => t !== name)
            : [...data.selectedTags, name];
    }
    function hrefFor(q: string, tagList: string[]): string {
        const p = new URLSearchParams();
        if (q) p.set('q', q);
        for (const t of tagList) p.append('tag', t);
        const s = p.toString();
        return s ? `/search?${s}` : '/search';
    }
    // ✕：从 URL 真正清掉关键词（保留已选标签），结果立即解除过滤；焦点回输入框
    function clearKeyword(): void {
        void goto(hrefFor('', data.selectedTags));
        searchInput?.focus();
    }
</script>

<div class="search-page">
    <h1>查找文档</h1>
    <form method="GET" action="/search" class="search-form">
        <div class="search-box" class:has-clear={data.q}>
            <input name="q" value={data.q} bind:this={searchInput} placeholder="搜索文件名或正文…" aria-label="搜索关键词" autofocus>
            {#if data.q}
                <button type="button" class="search-clear" aria-label="清空搜索关键词" onclick={clearKeyword}>✕</button>
            {/if}
        </div>
        {#each data.selectedTags as t}
            <input type="hidden" name="tag" value={t}>
        {/each}
        <button type="submit" class="btn primary">搜索</button>
    </form>

    <aside class="tag-filter">
        <h2>标签筛选</h2>
        {#if tags.length === 0}
            <p class="muted">暂无标签</p>
        {:else}
            <div class="chips">
                {#each tags as t (t.id)}
                    <a class="chip" class:active={data.selectedTags.includes(t.name)}
                       href={hrefFor(data.q, toggleTag(t.name))}>
                        {t.name} <span class="count">{t.docCount}</span>
                    </a>
                {/each}
            </div>
        {/if}
    </aside>

    <section class="results">
        {#if !data.q && data.selectedTags.length === 0}
            <p class="muted">输入关键词或选择标签开始查找。</p>
        {:else if data.results.length === 0}
            <p class="muted">没有匹配的文档。</p>
        {:else}
            {#if data.truncated}
                <p class="muted truncated">结果过多（仅显示前 {data.results.length} 条），请细化关键词或加标签筛选。</p>
            {/if}
            <ul>
                {#each data.results as r (r.doc.id)}
                    <li>
                        <a class="title" href="/d/{r.doc.id}">📄 {r.doc.name}</a>
                        {#if r.path.length > 0}
                            <span class="path">{r.path.map(p => p.name).join(' / ')}</span>
                        {/if}
                        {#if r.tags.length > 0}
                            <span class="tags">{#each r.tags as t}<span class="chip-static">{t.name}</span>{/each}</span>
                        {/if}
                        {#if r.snippet}
                            <p class="snippet">{@html r.snippet}</p>
                        {:else if r.doc.storageTier === 'cold'}
                            <p class="snippet muted">☁️ 已归档（仅标题可搜）</p>
                        {/if}
                    </li>
                {/each}
            </ul>
        {/if}
    </section>
</div>

<style>
    .search-page { font-family: system-ui, sans-serif; padding: 1.5rem; max-width: 960px; margin: 0 auto; }
    h1 { font-size: 1.25rem; }
    .search-form { display: flex; gap: 0.5rem; margin: 1rem 0; }
    .search-form input { flex: 1; padding: 0.5rem 0.7rem; border: 1px solid var(--rr-input-border); border-radius: 6px; font-size: 0.95rem; background: var(--rr-input-bg); color: var(--rr-text); }
    .search-form input:focus { outline: none; border-color: var(--rr-accent); box-shadow: 0 0 0 2px var(--rr-focus-ring); }
    /* ✕ 清空按钮：绝对定位在输入框最右侧，有关键词才出现（预留右内边距防文字压字；
       padding 撑到 ≥24×24 触屏命中区，WCAG 2.5.8） */
    .search-box { position: relative; flex: 1; }
    .search-box input { width: 100%; box-sizing: border-box; }
    .search-box.has-clear input { padding-right: 2rem; }
    .search-clear {
        position: absolute; right: 0.4rem; top: 50%; transform: translateY(-50%);
        border: none; background: none; cursor: pointer; padding: 0.375rem 0.45rem;
        color: var(--rr-text-muted); font-size: 0.8rem; line-height: 1; border-radius: 4px;
    }
    .search-clear:hover { color: var(--rr-text); background: var(--rr-hover-bg); }
    .btn { border: 1px solid var(--rr-btn-border); background: var(--rr-btn-bg); color: var(--rr-btn-text); cursor: pointer; padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 0.85rem; }
    .btn.primary { background: var(--rr-btn-primary-bg); color: var(--rr-btn-primary-text); border-color: var(--rr-btn-primary-bg); }
    .tag-filter { margin: 1rem 0; padding: 0.75rem; background: var(--rr-bg); border-radius: 6px; }
    .tag-filter h2 { font-size: 0.9rem; margin: 0 0 0.5rem; color: var(--rr-text-muted); }
    .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .chip { padding: 0.2rem 0.6rem; border: 1px solid var(--rr-border); border-radius: 999px; text-decoration: none; color: var(--rr-text); font-size: 0.8rem; background: var(--rr-card-bg); }
    .chip.active { background: var(--rr-accent); color: var(--rr-btn-primary-text); border-color: var(--rr-accent); }
    .chip .count { opacity: 0.7; font-size: 0.75rem; }
    .results ul { list-style: none; padding: 0; }
    .results li { padding: 0.6rem 0; border-bottom: 1px solid var(--rr-border-soft); }
    .title { color: var(--rr-link); text-decoration: none; font-weight: 500; }
    .title:hover { text-decoration: underline; }
    .path { color: var(--rr-text-muted); font-size: 0.8rem; margin-left: 0.5rem; }
    .tags { margin-left: 0.5rem; }
    .chip-static { display: inline-block; padding: 0 0.4rem; background: var(--rr-accent-soft); color: var(--rr-link); border-radius: 999px; font-size: 0.72rem; margin-right: 0.2rem; }
    .snippet { margin: 0.3rem 0 0; color: var(--rr-text-muted); font-size: 0.85rem; }
    .snippet :global(mark) { background: var(--rr-warning-soft); padding: 0 1px; }
    .muted { color: var(--rr-text-muted); }
    .truncated { background: var(--rr-warning-soft); border: 1px solid var(--rr-warning-border); padding: 0.4rem 0.6rem; border-radius: 5px; margin-bottom: 0.5rem; }
</style>
