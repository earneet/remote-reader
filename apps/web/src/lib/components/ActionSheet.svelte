<script lang="ts">
    // 底部 action sheet（spec 2026-09-14 §7.1）：<dialog> 原生 top-layer/Esc/焦点归还。
    // show()/hide() 经 bind:this 调用；选项回调 onSelect(key)。打开时锁 body 滚动。
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

    export function show(): void {
        dialog?.showModal();
        document.body.style.overflow = 'hidden';
    }
    export function hide(): void {
        dialog?.close();
    }

    function onDialogClose(): void {
        document.body.style.overflow = '';
    }

    function pick(key: string): void {
        hide();
        onSelect(key);
    }
</script>

<dialog
    class="sheet"
    aria-label={label}
    bind:this={dialog}
    onclose={onDialogClose}
>
    <ul class="sheet-list">
        {#each actions as a (a.key)}
            <li>
                <button type="button" class="action" class:danger={a.danger} onclick={() => pick(a.key)}>
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
