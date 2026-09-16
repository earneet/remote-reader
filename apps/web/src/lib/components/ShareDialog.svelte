<script lang="ts">
    // 分享链接浮层（spec 2026-09-16 §5.5）：居中 <dialog>，只读 URL + 复制（clipboard API +
    // execCommand 降级 + ✓ 反馈；非安全上下文降级失败仍可手动选中复制）。
    // Esc/backdrop/返回键关闭；滚动锁 + overlay-history 编排同 ActionSheet。
    import { lockBodyScroll, unlockBodyScroll } from '$lib/shared/body-scroll';
    import { createOverlayHistory } from '$lib/shared/overlay-history';

    let dialog = $state<HTMLDialogElement | null>(null);
    let url = $state('');
    let copied = $state(false);
    let copyFailed = $state(false);
    const overlayHistory = createOverlayHistory();

    export function show(u: string): void {
        url = u; copied = false; copyFailed = false;
        dialog?.showModal();
        lockBodyScroll();
        overlayHistory.push();
        // 聚焦并全选：Ctrl+C / 长按复制直接可用
        requestAnimationFrame(() => {
            const input = dialog?.querySelector<HTMLInputElement>('input.url');
            input?.focus();
            input?.select();
        });
    }

    export function hide(): void { dialog?.close(); }

    async function onDialogClose(): Promise<void> {
        unlockBodyScroll();
        await overlayHistory.consume();
    }

    async function copy(): Promise<void> {
        try {
            await navigator.clipboard.writeText(url);
            copied = true; copyFailed = false;
        } catch {
            // 降级：非安全上下文（HTTP）/权限拒绝 → 选中后 execCommand
            const input = dialog?.querySelector<HTMLInputElement>('input.url');
            let ok = false;
            if (input) {
                input.focus(); input.select();
                ok = document.execCommand('copy');
            }
            copied = ok; copyFailed = !ok;
        }
        if (copied) setTimeout(() => { copied = false; }, 2000);
    }

    // 系统返回键 = 关浮层而非真实后退（同 ActionSheet 编排）
    $effect(() => {
        const onPop = () => {
            if (dialog?.open) {
                overlayHistory.markConsumedByPop();
                dialog.close();
            }
        };
        window.addEventListener('popstate', onPop);
        return () => window.removeEventListener('popstate', onPop);
    });
</script>

<dialog class="share" aria-label="分享链接" bind:this={dialog} onclose={onDialogClose}
    onclick={(e) => { if (e.target === dialog) hide(); }}>
    <h2>分享链接</h2>
    <p class="hint">凭此链接免登录查看文档；转为私有后立即失效。</p>
    <input class="url" value={url} readonly>
    <div class="row">
        <button type="button" class="btn primary" onclick={() => void copy()}>
            {copied ? '已复制 ✓' : '复制链接'}
        </button>
        <button type="button" class="btn" onclick={hide}>关闭</button>
        {#if copyFailed}<span class="error">复制失败，请手动选中上方内容复制</span>{/if}
    </div>
</dialog>

<style>
    .share {
        margin: auto; /* 居中 */
        width: min(92vw, 34rem); box-sizing: border-box;
        border: 1px solid var(--rr-border); border-radius: 10px;
        padding: 1.25rem 1.25rem 1rem;
        background: var(--rr-card-bg); color: var(--rr-text);
        font-family: system-ui, sans-serif;
    }
    .share::backdrop { background: var(--rr-scrim); }
    h2 { margin: 0 0 0.4rem; font-size: 1.1rem; }
    .hint { margin: 0 0 0.8rem; font-size: 0.85rem; opacity: 0.75; }
    .url {
        width: 100%; box-sizing: border-box; padding: 0.45rem 0.6rem;
        border: 1px solid var(--rr-border); border-radius: 6px;
        background: var(--rr-input-bg); color: var(--rr-text);
        font-size: 0.85rem; font-family: ui-monospace, monospace;
    }
    .row { display: flex; align-items: center; gap: 0.5rem; margin-top: 0.8rem; }
    .error { color: var(--rr-danger); font-size: 0.8rem; }
</style>
