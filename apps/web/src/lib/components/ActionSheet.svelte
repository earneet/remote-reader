<script lang="ts">
    // 底部 action sheet（spec 2026-09-14 §7.1）：<dialog> 原生 top-layer/Esc/焦点归还。
    // show()/hide() 经 bind:this 调用；选项回调 onSelect(key)。打开时锁 body 滚动（引用计数）、
    // 推浅路由条目兜 Android 返回键（P2-11 + 备忘 D-9，与移动抽屉同款编排）。
    // pick 先 await 消费完条目再 onSelect——onSelect 可能立刻开抽屉（再推新条目），
    // 乱序会把抽屉的条目弹掉
    import { lockBodyScroll, unlockBodyScroll } from '$lib/shared/body-scroll';
    import { createOverlayHistory } from '$lib/shared/overlay-history';

    let {
        label = '操作',
        actions,
        onSelect
    }: {
        label?: string;
        actions: { key: string; label: string; danger?: boolean }[];
        onSelect: (key: string) => void;
    } = $props();

    let dialog = $state<HTMLDialogElement | null>(null);
    const overlayHistory = createOverlayHistory();

    export function show(): void {
        dialog?.showModal();
        lockBodyScroll();
        overlayHistory.push();
    }

    export function hide(): void {
        dialog?.close();
    }

    // dialog.close() 的 close 事件异步派发（HTML 规范排队任务）——解锁与条目消费统一收口在此
    async function onDialogClose(): Promise<void> {
        unlockBodyScroll();
        await overlayHistory.consume();
    }

    async function pick(key: string): Promise<void> {
        await overlayHistory.consume();
        hide();
        onSelect(key);
    }

    // 系统返回键 = 关 sheet 而非真实后退：popstate 先标记条目已消费，再关 dialog
    //（close 事件里 consume 因标记而为 no-op，不重复 back）
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

<dialog
    class="sheet"
    aria-label={label}
    bind:this={dialog}
    onclose={onDialogClose}
    onclick={(e) => { if (e.target === dialog) hide(); }}
>
    <ul class="sheet-list">
        {#each actions as a (a.key)}
            <li>
                <button type="button" class="action" class:danger={a.danger} onclick={() => void pick(a.key)}>
                    {a.label}
                </button>
            </li>
        {/each}
    </ul>
    <button type="button" class="action cancel" onclick={hide}>取消</button>
</dialog>

<style>
    .sheet {
        position: fixed; inset: auto 0 0 0;
        width: 100%; max-width: 30rem; margin: 0 auto;
        box-sizing: border-box;
        border: none; border-radius: 12px 12px 0 0;
        padding: 0.5rem 0.75rem calc(0.75rem + env(safe-area-inset-bottom, 0px));
        background: var(--rr-card-bg); color: var(--rr-text);
        font-family: system-ui, sans-serif;
    }
    .sheet::backdrop { background: var(--rr-scrim); }
    .sheet[open] { animation: sheet-in 180ms ease-out; }
    @keyframes sheet-in { from { transform: translateY(100%); } }

    .sheet-list { list-style: none; margin: 0; padding: 0; }
    .action {
        display: block; width: 100%; min-height: 48px;
        border: none; background: none; cursor: pointer;
        padding: 0.75rem 0.5rem; font-size: 1rem; text-align: center;
        border-radius: 8px; color: var(--rr-text);
    }
    .action:hover { background: var(--rr-hover-bg); }
    .action:active { background: var(--rr-hover-bg); }
    .action:focus-visible { outline: 2px solid var(--rr-accent); outline-offset: -2px; }
    .action.danger { color: var(--rr-danger); }
    .sheet-list li + li .action { border-top: 1px solid var(--rr-border-soft); }
    .cancel { margin-top: 0.5rem; font-weight: 600; border-top: 1px solid var(--rr-border); border-radius: 8px; }
</style>
