<script lang="ts">
    import MarkdownViewer from '$components/MarkdownViewer.svelte';
    let { data } = $props();
</script>

<svelte:head>
    <title>{data.title}</title>
</svelte:head>

<a class="back" href="/">← 返回我的文档库</a>

<MarkdownViewer html={data.html} />

<style>
    .back {
        display: inline-block;
        max-width: 760px;
        margin: 0 auto;
        padding: 1rem 2rem 0;
        color: #0969da;
    }
</style>
