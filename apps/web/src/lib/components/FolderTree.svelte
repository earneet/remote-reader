<script lang="ts">
    import { untrack } from 'svelte';
    import { fade } from 'svelte/transition';
    import { ancestorsOf, visibleNodes, type TreeFolder } from '$lib/shared/folder-tree';

    let {
        folders,
        currentId,
        selecting = false,
        onSelect,
        storageKey
    }: {
        folders: TreeFolder[];
        currentId?: string | null;
        selecting?: boolean;
        onSelect?: (id: string | null) => void;
        storageKey: string;
    } = $props();

    let expanded = $state<Set<string>>(new Set());
    let restored = $state(false);

    const tree = $derived(visibleNodes(folders, expanded));
    const totalCount = (f: TreeFolder) => f.childFolders + f.childFiles;
    const isOpen = (id: string) => expanded.has(id);

    // ① 挂载后恢复记忆：SSR 首帧按全折叠渲染，hydrate 后恢复（spec §3.2，同 theme 初始化模式）
    $effect(() => {
        if (restored) return;
        restored = true;
        try {
            const raw = localStorage.getItem(storageKey);
            const ids = raw ? JSON.parse(raw) : null;
            if (Array.isArray(ids)) expanded = new Set(ids.filter((x): x is string => typeof x === 'string'));
        } catch {
            // 损坏数据忽略，保持全折叠
        }
    });

    // ② currentId 变化 → 祖先链并入（只增不减，spec §3.2）。
    // 关键：effect 仅依赖 currentId——folders/expanded 的读写都包进 untrack。
    // 若对 expanded 建立依赖：用户手动折叠当前目录的祖先 → toggle 写 expanded → 本 effect 重跑 →
    // 祖先被立即加回（折叠回弹）。若对 folders 建立依赖：任何 invalidateAll（新建/重命名/删除/移动）
    // 后 folders 数组更新 → 同样回弹。spec 的触发条件是"currentId 变化"，故仅依赖 currentId。
    $effect(() => {
        if (!currentId) return;
        untrack(() => {
            const anc = ancestorsOf(folders, currentId);
            let changed = false;
            const next = new Set(expanded);
            for (const id of anc) {
                if (!next.has(id)) { next.add(id); changed = true; }
            }
            if (changed) expanded = next;
        });
    });

    // ③ 持久化：恢复完成后的每次变化写回 localStorage（隐私模式写失败忽略）
    $effect(() => {
        if (!restored) return; // 恢复前不回写，防止首帧用 ∅ 覆盖记忆
        try {
            localStorage.setItem(storageKey, JSON.stringify([...expanded]));
        } catch {
            // 忽略
        }
    });

    function toggle(id: string) {
        const next = new Set(expanded);
        if (next.has(id)) next.delete(id);
        else next.add(id);
        expanded = next;
    }
</script>

<ul class="tree">
    <li>
        <div class="row">
            <span class="chevron placeholder" aria-hidden="true"></span>
            <button
                class="label root"
                class:active={currentId === null}
                class:pick={selecting}
                onclick={() => onSelect?.(null)}
            >
                <svg class="folder-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M6.906.664a1.75 1.75 0 0 0-2.187 0l-4.5 3.63A1.75 1.75 0 0 0 0 5.668v8.582c0 .414.336.75.75.75h4a.75.75 0 0 0 .75-.75V10.5h4v3.75c0 .414.336.75.75.75h4a.75.75 0 0 0 .75-.75V5.668a1.75 1.75 0 0 0-.719-1.374l-4.5-3.63Zm-1.281 1.18a.25.25 0 0 1 .312 0l4.187 3.376H1.438L5.625 1.844Z"></path></svg>
                <span class="name">根目录</span>
            </button>
        </div>
    </li>
    {#each tree as f (f.id)}
        <li style="padding-left:{f.depth * 0.9}rem" transition:fade={{ duration: 80 }}>
            <div class="row" class:empty={totalCount(f) === 0}>
                {#if f.childFolders > 0}
                    <button
                        class="chevron"
                        class:open={isOpen(f.id)}
                        aria-expanded={isOpen(f.id)}
                        aria-label={isOpen(f.id) ? `折叠 ${f.name}` : `展开 ${f.name}`}
                        onclick={() => toggle(f.id)}
                    >
                        <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true"><path d="M6.22 3.22a.75.75 0 0 1 1.06 0l4.25 4.25a.75.75 0 0 1 0 1.06l-4.25 4.25a.75.75 0 0 1-1.06-1.06L9.94 8 6.22 4.28a.75.75 0 0 1 0-1.06Z"></path></svg>
                    </button>
                {:else}
                    <span class="chevron placeholder" aria-hidden="true"></span>
                {/if}
                <button
                    class="label"
                    class:active={f.id === currentId}
                    class:pick={selecting}
                    title={totalCount(f) > 0 ? `${f.childFolders} 个子文件夹 · ${f.childFiles} 个文件` : undefined}
                    onclick={() => onSelect?.(f.id)}
                >
                    {#if isOpen(f.id) && f.childFolders > 0}
                        <svg class="folder-icon open" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M.75 4.5h4.09l1.2 1.6a1 1 0 0 0 .8.4h6.36a.75.75 0 0 1 .75.75v.09L.75 8.6V4.5Zm0 5.7 14.2-1.26v4.06a.75.75 0 0 1-.75.75H1.5a.75.75 0 0 1-.75-.75v-2.8Z"></path></svg>
                    {:else}
                        <svg class="folder-icon" viewBox="0 0 16 16" width="16" height="16" fill="currentColor" aria-hidden="true"><path d="M1.75 1A1.75 1.75 0 0 0 0 2.75v10.5C0 14.216.784 15 1.75 15h12.5A1.75 1.75 0 0 0 16 13.25v-8.5A1.75 1.75 0 0 0 14.25 3H7.5a.25.25 0 0 1-.2-.1l-.9-1.2C6.07 1.26 5.55 1 5 1H1.75Z"></path></svg>
                    {/if}
                    <span class="name">{f.name}</span>
                    {#if totalCount(f) > 0}
                        <span class="count">{totalCount(f)}</span>
                    {/if}
                </button>
            </div>
        </li>
    {/each}
</ul>

<style>
    .tree { list-style: none; padding: 0; margin: 0; font-family: system-ui, sans-serif; }
    .row { display: flex; align-items: center; gap: 0.1rem; }
    .row.empty { opacity: 0.6; }

    .chevron {
        width: 1.35rem; height: 1.75rem; flex-shrink: 0;
        display: inline-flex; align-items: center; justify-content: center;
        border: none; background: none; cursor: pointer; color: var(--rr-text-muted);
        border-radius: 4px; padding: 0;
    }
    .chevron svg { transition: transform 120ms ease; }
    .chevron.open svg { transform: rotate(90deg); }
    .chevron.placeholder { pointer-events: none; }
    .chevron:hover { background: var(--rr-hover-bg); color: var(--rr-text); }

    .label {
        flex: 1; min-width: 0;
        display: flex; align-items: center; gap: 0.35rem;
        border: none; background: none; cursor: pointer;
        padding: 0.3rem 0.4rem; border-radius: 4px;
        text-align: left; width: auto; color: var(--rr-text);
    }
    .label:hover { background: var(--rr-hover-bg); }
    .label.active { background: var(--rr-accent-soft); font-weight: 600; }
    .label.pick { background: var(--rr-success-soft); outline: 2px solid var(--rr-success); }
    .label:focus-visible, .chevron:focus-visible { outline: 2px solid var(--rr-accent); outline-offset: -1px; }

    .folder-icon { flex-shrink: 0; color: var(--rr-link); }
    .label.root .folder-icon { color: var(--rr-text-muted); }

    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { margin-left: auto; flex-shrink: 0; color: var(--rr-text-muted); font-size: 0.72rem; font-variant-numeric: tabular-nums; }
</style>
