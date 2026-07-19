<script lang="ts">
    let { html }: { html: string } = $props();
    let container: HTMLDivElement;

    $effect(() => {
        if (container && html) {
            enhanceMermaid(container);
            enhanceKatex(container);
        }
    });

    async function enhanceMermaid(root: HTMLElement): Promise<void> {
        const codeBlocks = Array.from(root.querySelectorAll<HTMLElement>('code.language-mermaid'));
        if (codeBlocks.length === 0) return;
        const mermaid = (await import('mermaid')).default;
        mermaid.initialize({ startOnLoad: false, theme: 'dark' });
        for (const code of codeBlocks) {
            const pre = code.parentElement;
            if (!pre) continue;
            const id = 'mmd-' + Math.random().toString(36).slice(2, 9);
            try {
                const { svg } = await mermaid.render(id, code.textContent ?? '');
                const div = document.createElement('div');
                div.className = 'mermaid-rendered';
                div.innerHTML = svg;
                pre.replaceWith(div);
            } catch (e) {
                console.warn('[mermaid] render failed', e);
            }
        }
    }

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

<style>
    .markdown-body {
        max-width: 760px;
        margin: 0 auto;
        padding: 2rem;
        line-height: 1.7;
        font-family: system-ui, -apple-system, sans-serif;
        color: #1f2328;
    }
    .markdown-body :global(a) {
        color: #0969da;
    }
    .markdown-body :global(pre) {
        padding: 1rem;
        border-radius: 6px;
        overflow-x: auto;
        margin: 1rem 0;
    }
    .markdown-body :global(code) {
        font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
        font-size: 0.9em;
    }
    .markdown-body :global(:not(pre) > code) {
        padding: 0.15em 0.35em;
        background: #f6f8fa;
        border-radius: 4px;
    }
    .markdown-body :global(table) {
        border-collapse: collapse;
        margin: 1rem 0;
    }
    .markdown-body :global(th),
    .markdown-body :global(td) {
        border: 1px solid #d0d7de;
        padding: 0.4rem 0.8rem;
    }
    .markdown-body :global(blockquote) {
        border-left: 3px solid #d0d7de;
        margin: 1rem 0;
        padding: 0 1rem;
        color: #57606a;
    }
    .markdown-body :global(.mermaid-rendered) {
        text-align: center;
        margin: 1rem 0;
    }
    .markdown-body :global(.math.block) {
        margin: 1rem 0;
        overflow-x: auto;
    }
</style>
