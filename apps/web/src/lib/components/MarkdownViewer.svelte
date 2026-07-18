<script lang="ts">
    let { html }: { html: string } = $props();
</script>

<div class="markdown-body">
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
</style>
