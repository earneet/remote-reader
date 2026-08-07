<script lang="ts">
    import MermaidViewer from '$components/MermaidViewer.svelte';
    import TableFullscreen from '$components/TableFullscreen.svelte';
    let { html }: { html: string } = $props();
    let container: HTMLDivElement | undefined = $state(undefined);

    $effect(() => {
        if (container && html) enhanceKatex(container);
    });

    async function enhanceKatex(root: HTMLElement): Promise<void> {
        const nodes = Array.from(root.querySelectorAll<HTMLElement>('.math.inline, .math.block'));
        if (nodes.length === 0) return;
        const katex = (await import('katex')).default;
        for (const el of nodes) {
            try {
                el.innerHTML = katex.renderToString(el.textContent ?? '', {
                    displayMode: el.classList.contains('block'),
                    throwOnError: false
                });
            } catch (e) {
                console.warn('[katex] render failed', e);
            }
        }
    }
</script>

<div class="markdown-body" bind:this={container}>
    {@html html}
</div>
<MermaidViewer {container} {html} />
<TableFullscreen {container} {html} />

<style>
    @font-face {
        font-family: "RR Mono";
        src: local("Sarasa Mono SC"),
             local("Sarasa Term SC"),
             local("Sarasa Fixed SC"),
             local("Noto Sans Mono CJK SC"),
             local("Source Han Mono SC"),
             local("思源等宽"),
             url("/fonts/rr-mono-sc.woff2") format("woff2");
        font-display: swap;
        font-weight: 400;
        font-style: normal;
    }
    .markdown-body {
        width: 100%;
        max-width: 960px;
        margin: 0 auto;
        padding: 2rem;
        box-sizing: border-box;
        min-width: 0;
        overflow-wrap: anywhere;
        font-size: 16px;
        line-height: 1.75;
        font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
        color: var(--rr-text, #1f2328);
        --rr-mono: "RR Mono", "Sarasa Mono SC", "Noto Sans Mono CJK SC", "Source Han Mono SC", "思源等宽", ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Mono", "Cascadia Code", Consolas, "Liberation Mono", "DejaVu Sans Mono", Menlo, monospace;
        --rr-mono-west: ui-monospace, SFMono-Regular, "SF Mono", "Cascadia Mono", "Cascadia Code", Consolas, "Liberation Mono", "DejaVu Sans Mono", Menlo, monospace;
    }
    .markdown-body :global(a) {
        color: var(--rr-link, #0969da);
    }
    .markdown-body :global(a:hover) {
        text-decoration: underline;
    }
    .markdown-body :global(h1),
    .markdown-body :global(h2) {
        border-bottom: 1px solid var(--rr-border-soft, #eaecef);
        padding-bottom: 0.3em;
    }
    .markdown-body :global(pre) {
        padding: 1rem;
        border-radius: 8px;
        overflow-x: auto;
        max-width: 100%;
        margin: 1rem 0;
        font-size: 0.9em;
        font-family: var(--rr-mono-west);
        font-variant-ligatures: none;
        font-feature-settings: "liga" 0, "calt" 0;
        tab-size: 4;
    }
    .markdown-body :global(pre[data-rr-code="ascii"]) {
        font-family: var(--rr-mono);
    }
    .markdown-body :global(pre[data-rr-code="ascii"] code) {
        font-family: var(--rr-mono);
    }
    .markdown-body :global(code) {
        font-variant-ligatures: none;
        font-feature-settings: "liga" 0, "calt" 0;
    }
    .markdown-body :global(:not(pre) > code) {
        font-family: var(--rr-mono-west);
        padding: 0.15em 0.35em;
        background: var(--rr-inline-code-bg, #eff2f5);
        color: var(--rr-inline-code-text, #bc4b00);
        border-radius: 4px;
    }
    .markdown-body :global(.rr-table-wrap) {
        overflow-x: auto;
        max-width: 100%;
        margin: 1rem 0;
    }
    .markdown-body :global(.rr-table-outer) { position: relative; }
    .markdown-body :global(.rr-table-fs-btn) { display: none; }
    .markdown-body :global(.rr-table-expand-btn) { display: none; }
    @media (min-width: 769px) {
        .markdown-body :global(.rr-table-outer.rr-wide-d) {
            max-width: 95vw;
            min-width: 100%;
            position: relative;
            left: 50%;
            transform: translateX(-50%);
        }
        .markdown-body :global(.rr-table-outer.rr-wide-d .rr-table-wrap table) {
            width: 100%;
        }
        .markdown-body :global(.rr-table-outer .rr-table-expand-btn) {
            position: absolute;
            top: 4px;
            right: 4px;
            z-index: 2;
            display: inline-block;
            padding: 2px 10px;
            border-radius: 5px;
            border: 1px solid var(--rr-border, #d0d7de);
            background: var(--rr-card-bg, #fff);
            color: var(--rr-text-muted, #57606a);
            cursor: pointer;
            font-size: 12px;
            line-height: 1.5;
            white-space: nowrap;
        }
        .markdown-body :global(.rr-table-outer .rr-table-expand-btn:hover) {
            background: var(--rr-bg, #f6f8fa);
        }
    }
    @media (max-width: 768px) {
        .markdown-body :global(.rr-table-wrap.rr-shrink) {
            font-size: 0.9em;
        }
        .markdown-body :global(.rr-table-outer.rr-wide .rr-table-fs-btn) {
            display: inline-flex; align-items: center; justify-content: center;
            position: absolute; top: 4px; right: 4px; z-index: 2;
            width: 28px; height: 28px; border-radius: 5px;
            border: 1px solid var(--rr-border, #d0d7de);
            background: var(--rr-card-bg, #fff); color: var(--rr-text-muted, #57606a);
            cursor: pointer; font-size: 14px; line-height: 1;
        }
    }
    .markdown-body :global(table) {
        border-collapse: collapse;
    }
    .markdown-body :global(th),
    .markdown-body :global(td) {
        border: 1px solid var(--rr-border, #d0d7de);
        padding: 0.4rem 0.8rem;
        overflow-wrap: break-word;
    }
    .markdown-body :global(blockquote) {
        border-left: 3px solid var(--rr-border, #d0d7de);
        margin: 1rem 0;
        padding: 0 1rem;
        color: var(--rr-text-muted, #57606a);
    }
    .markdown-body :global(img) {
        max-width: 100%;
    }
    .markdown-body :global(.math.block) {
        margin: 1rem 0;
        overflow-x: auto;
    }
    @media (max-width: 768px) {
        .markdown-body {
            padding: 1rem;
        }
    }
</style>
