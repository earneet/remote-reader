<script lang="ts">
    type Folder = { id: string; name: string; parentId: string | null };
    let {
        folders,
        currentId = null as string | null,
        selecting = false,
        onSelect
    }: {
        folders: Folder[];
        currentId?: string | null;
        selecting?: boolean;
        onSelect?: (id: string | null) => void;
    } = $props();

    type Flat = Folder & { depth: number };
    const tree = $derived.by<Flat[]>(() => {
        const byParent = new Map<string | null, Folder[]>();
        for (const f of folders) {
            const arr = byParent.get(f.parentId) ?? [];
            arr.push(f);
            byParent.set(f.parentId, arr);
        }
        const out: Flat[] = [];
        const walk = (parentId: string | null, depth: number) => {
            for (const f of byParent.get(parentId) ?? []) {
                out.push({ ...f, depth });
                walk(f.id, depth + 1);
            }
        };
        walk(null, 0);
        return out;
    });
</script>

<ul class="tree">
    <li>
        <button
            class:active={currentId === null}
            class:pick={selecting}
            onclick={() => onSelect?.(null)}
        >🏠 根目录</button>
    </li>
    {#each tree as f (f.id)}
        <li style="padding-left:{f.depth + 1}rem">
            <button
                class:active={f.id === currentId}
                class:pick={selecting}
                onclick={() => onSelect?.(f.id)}
            >📁 {f.name}</button>
        </li>
    {/each}
</ul>

<style>
    .tree { list-style: none; padding: 0; margin: 0; font-family: system-ui, sans-serif; }
    .tree button {
        border: none; background: none; cursor: pointer; padding: 0.3rem 0.5rem;
        border-radius: 4px; text-align: left; width: 100%; color: #1f2328;
    }
    .tree button:hover { background: #f6f8fa; }
    .tree button.active { background: #ddf4ff; font-weight: 600; }
    .tree button.pick { background: #dafbe1; outline: 2px solid #2da44e; }
</style>
