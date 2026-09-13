<script lang="ts">
    let { data } = $props();
    const tags = $derived(data.allTags);
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
</script>

<div class="search-page">
    <h1>查找文档</h1>
    <form method="GET" action="/search" class="search-form">
        <input name="q" value={data.q} placeholder="搜索文件名或正文…" autofocus>
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
    .btn { border: 1px solid var(--rr-btn-border); background: var(--rr-btn-bg); color: var(--rr-btn-text); cursor: pointer; padding: 0.4rem 0.9rem; border-radius: 6px; font-size: 0.85rem; }
    .btn.primary { background: var(--rr-btn-primary-bg); color: var(--rr-btn-primary-text); border-color: var(--rr-btn-primary-bg); }
    .tag-filter { margin: 1rem 0; padding: 0.75rem; background: var(--rr-bg); border-radius: 6px; }
    .tag-filter h2 { font-size: 0.9rem; margin: 0 0 0.5rem; color: var(--rr-text-muted); }
    .chips { display: flex; flex-wrap: wrap; gap: 0.4rem; }
    .chip { padding: 0.2rem 0.6rem; border: 1px solid var(--rr-border); border-radius: 999px; text-decoration: none; color: var(--rr-text); font-size: 0.8rem; background: var(--rr-card-bg); }
    .chip.active { background: var(--rr-accent); color: #ffffff; border-color: var(--rr-accent); }
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
