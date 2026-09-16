<script lang="ts">
    // 行首文档状态图标（spec 2026-09-16 §5.1）：文件夹 / 私有文件 / 共享文件（右下链接角标）三形态。
    // currentColor 描边随主题/上下文；共享角标语义色走 --rr-link（theme.css 单源，禁写死色值）
    let {
        type,
        shared = false
    }: {
        type: 'file' | 'folder';
        shared?: boolean;
    } = $props();

    const label = $derived(type === 'file' ? (shared ? '已共享' : '私有') : null);
</script>

<span class="doc-icon" aria-label={label ?? undefined} title={label ?? undefined}>
    {#if type === 'folder'}
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
            stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">
            <path d="M1.75 3h4.2a1 1 0 0 1 .78.37l1.1 1.38a.4.4 0 0 0 .31.15h6.11a.75.75 0 0 1 .75.75v6.85a.75.75 0 0 1-.75.75H1.75a.75.75 0 0 1-.75-.75V3.75A.75.75 0 0 1 1.75 3Z"></path>
        </svg>
    {:else}
        <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor"
            stroke-width="1.3" stroke-linejoin="round" aria-hidden="true">
            <path d="M4 2h8a.75.75 0 0 1 .75.75v10.5a.75.75 0 0 1-.75.75H4a.75.75 0 0 1-.75-.75V2.75A.75.75 0 0 1 4 2Z"></path>
            <path stroke-linecap="round" stroke-width="1.1" d="M5.75 6h4.5M5.75 8.5h4.5"></path>
            {#if shared}
                <!-- 链接角标：卡底圆 + 双环链扣（--rr-link 语义色，深浅主题自适应） -->
                <circle cx="11.9" cy="11.9" r="3.7" fill="var(--rr-card-bg)" stroke="var(--rr-link)" stroke-width="1.2"></circle>
                <circle cx="11.05" cy="12.75" r="1.15" stroke="var(--rr-link)" stroke-width="1"></circle>
                <circle cx="12.75" cy="11.05" r="1.15" stroke="var(--rr-link)" stroke-width="1"></circle>
            {:else}
                <path stroke-linecap="round" stroke-width="1.1" d="M5.75 11h3"></path>
            {/if}
        </svg>
    {/if}
</span>

<style>
    .doc-icon { display: inline-flex; flex-shrink: 0; vertical-align: -0.15rem; }
</style>
