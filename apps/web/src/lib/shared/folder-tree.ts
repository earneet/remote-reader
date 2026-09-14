// 目录树纯函数：组件不持有树逻辑，可独立单测（spec §5.1）
export type TreeFolder = {
    id: string;
    name: string;
    parentId: string | null;
    childFolders: number; // 直接子文件夹数
    childFiles: number;   // 直接子文件数
};

export type FlatNode = TreeFolder & { depth: number };

const MAX_TREE_DEPTH = 1000; // 与 search.ts 同款防环深度上限

// id 的祖先 folder id 链，自顶向下、不含自身；环/脏数据触发上限安全截断
export function ancestorsOf(folders: TreeFolder[], id: string): string[] {
    const byId = new Map(folders.map(fr => [fr.id, fr]));
    const out: string[] = [];
    let cursor = byId.get(id)?.parentId ?? null;
    let depth = 0;
    while (cursor) {
        if (depth++ > MAX_TREE_DEPTH) break;
        out.unshift(cursor);
        cursor = byId.get(cursor)?.parentId ?? null;
    }
    return out;
}

// 深度优先平铺：仅当节点 ∈ expanded 才继续下探其子；孤儿（父不在集合）天然不可达不渲染
export function visibleNodes(folders: TreeFolder[], expanded: ReadonlySet<string>): FlatNode[] {
    const byParent = new Map<string | null, TreeFolder[]>();
    for (const fr of folders) {
        const arr = byParent.get(fr.parentId) ?? [];
        arr.push(fr);
        byParent.set(fr.parentId, arr);
    }
    const out: FlatNode[] = [];
    const walk = (parentId: string | null, depth: number) => {
        for (const fr of byParent.get(parentId) ?? []) {
            out.push({ ...fr, depth });
            if (expanded.has(fr.id)) walk(fr.id, depth + 1);
        }
    };
    walk(null, 0);
    return out;
}

// 面包屑：parentId 的祖先 folder 名链（自顶向下，含 parentId 指向的文件夹自身）；
// 父缺失即止（脏数据安全），环走 MAX_TREE_DEPTH 上限安全截断。组件应预建 Map 复用（避免每行 O(n) 重建）。
export function folderNamesOf(byId: Map<string, TreeFolder>, parentId: string | null): string[] {
    const out: string[] = [];
    let cursor = parentId;
    let depth = 0;
    while (cursor) {
        const node = byId.get(cursor);
        if (!node) break;
        if (depth++ > MAX_TREE_DEPTH) break;
        out.unshift(node.name);
        cursor = node.parentId;
    }
    return out;
}

// 面包屑用：目录自身的祖先链（自顶向下、含自身，带 id 供点击导航）；
// 父缺失即止（脏数据安全），环走 MAX_TREE_DEPTH 上限安全截断。
export type Crumb = { id: string; name: string };
export function ancestorChainOf(byId: Map<string, TreeFolder>, id: string): Crumb[] {
    const out: Crumb[] = [];
    let cursor: string | null = id;
    let depth = 0;
    while (cursor) {
        const node = byId.get(cursor);
        if (!node) break;
        if (depth++ > MAX_TREE_DEPTH) break;
        out.unshift({ id: node.id, name: node.name });
        cursor = node.parentId;
    }
    return out;
}
