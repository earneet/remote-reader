# 目录树产品级完善 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 文件管理页左栏目录树从"永久平铺"升级为产品级：折叠/展开 + 状态记忆 + 当前路径自动定位 + 子项计数 + SVG 视觉 + a11y。

**Architecture:** 保持 flat 渲染。树逻辑（祖先链、折叠过滤）提取为纯函数 `folder-tree.ts` 单测覆盖；后端仅新增一条 GROUP BY 聚合 `folderChildCounts`；`FolderTree.svelte` 重写交互与视觉，`+page.svelte` 做数据组装。spec：`docs/superpowers/specs/2026-09-07-folder-tree-polish-design.md`。

**Tech Stack:** SvelteKit (Svelte 5 runes) · Drizzle ORM + better-sqlite3 · vitest（node 运行时）

**运行时注意（项目铁律）**：测试必须 `bun run test`（vitest 经 node 跑，bun 直跑 better-sqlite3 会挂）；类型检查 `bun --filter remote-reader-web check`；dev 用 `bun --filter remote-reader-web dev`（端口 5173，被占自动切 5174）。

---

### Task 1: 后端 `folderChildCounts` 聚合函数

**Files:**
- Modify: `apps/web/src/lib/server/documents.ts`（import 行 + `listFolders` 之后新增函数，约 L184 后）
- Test: `apps/web/tests/documents.test.ts`（文件末尾追加）

- [ ] **Step 1: 写失败测试**

在 `apps/web/tests/documents.test.ts` 末尾追加（沿用文件顶部已有 import：`uploadDocument`、`listFolders` 已导入，`folderChildCounts` 需加进 `../src/lib/server/documents` 的 import 列表；`folderByName` helper 已在文件中部定义，测试位于其后即可直接用）：

```typescript
// ── folderChildCounts：目录树子项计数 ────────────────────────

test('folderChildCounts 按直接子项聚合 folder/file 数', async () => {
    // 结构：reports/（1 文件 + 1 子文件夹 reports/2026）、reports/2026/（1 文件）、根（1 文件 + 1 文件夹）、
    // pf/（仅 1 个子文件夹 pf/sub，文件在 sub 里 → 纯文件夹父级）
    await uploadDocument(ownerId, 'r1.md', 'x', ['reports']);
    await uploadDocument(ownerId, 'y.md', 'y', ['reports', '2026']);
    await uploadDocument(ownerId, 'root.md', 'z', []);
    await uploadDocument(ownerId, 'pf.md', 'w', ['pf', 'sub']);
    const reports = folderByName('reports')!;
    const y2026 = folderByName('2026')!;
    const pf = folderByName('pf')!;
    const counts = folderChildCounts(ownerId);
    expect(counts.get(reports.id)).toEqual({ folders: 1, files: 1 });
    expect(counts.get(y2026.id)).toEqual({ folders: 0, files: 1 });
    expect(counts.get(pf.id)).toEqual({ folders: 1, files: 0 }); // 纯文件夹父级
});

test('folderChildCounts 空文件夹不入 map，有子项的准确计数', async () => {
    // empty-dir 里有 1 个 file 子项；truly-empty 直接插行、无任何子项
    await uploadDocument(ownerId, 'a.md', 'x', ['empty-dir']);
    const fid = generateId();
    db.insert(schema.documents).values({
        id: fid, ownerId, parentId: null, name: 'truly-empty', type: 'folder',
        storagePath: null, contentHash: null, sizeBytes: null,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    const counts = folderChildCounts(ownerId);
    expect(counts.get(fid)).toBeUndefined(); // 无子项的 folder 不出现在 map（UI 侧 ?? {0,0} 兜底）
    expect(counts.get(folderByName('empty-dir')!.id)).toEqual({ folders: 0, files: 1 });
});

test('folderChildCounts owner 隔离：不数别人的子项；无文档 owner 返回空 Map', async () => {
    await uploadDocument(ownerId, 'mine.md', 'x', ['shared-name']);
    // 另一个 owner：必须先建 users 行——documents.owner_id 有 FK → users.id 且 foreign_keys=ON（H3），
    // 直接插 documents 行会抛 FOREIGN KEY constraint failed
    db.insert(schema.users).values({
        id: 'user-x', email: 'user-x@t.com', passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
    expect(folderChildCounts('user-x').size).toBe(0); // 空 owner：无任何文档 → 空 Map
    db.insert(schema.documents).values({
        id: generateId(), ownerId: 'user-x', parentId: null, name: 'fx', type: 'folder',
        storagePath: null, contentHash: null, sizeBytes: null,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    db.insert(schema.documents).values({
        id: generateId(), ownerId: 'user-x', parentId: db.select().from(schema.documents)
            .where(and(eq(schema.documents.ownerId, 'user-x'), eq(schema.documents.name, 'fx'))).get()!.id,
        name: 'child.md', type: 'file', storagePath: null, contentHash: null, sizeBytes: 1,
        createdAt: Date.now(), updatedAt: Date.now()
    }).run();
    const counts = folderChildCounts(ownerId);
    expect(counts.size).toBe(1); // 只有 shared-name，user-x 的子项不串
});
```

注意：`generateId` 已在该测试文件 import（from `../src/lib/server/auth`）。第三个测试里 `user-x` 的行会在 `beforeEach` 的 `db.delete(schema.documents)` 清掉，无泄漏。

- [ ] **Step 2: 把 `folderChildCounts` 加进测试文件 import 并跑测试确认失败**

import 处改为：

```typescript
import {
    uploadDocument,
    listChildren,
    listFolders,
    folderChildCounts,
    getOwnedDocument,
    renameNode,
    moveNode,
    deleteNode
} from '../src/lib/server/documents';
```

Run: `bun run test apps/web/tests/documents.test.ts -t folderChildCounts`
Expected: FAIL（`folderChildCounts` 不是 `documents` 的导出 / undefined is not a function）

- [ ] **Step 3: 实现**

`apps/web/src/lib/server/documents.ts`：

第 1 行 import 改为：

```typescript
import { eq, and, isNull, isNotNull, inArray, ne, sql } from 'drizzle-orm';
```

在 `listFolders` 函数（约 L177-184）之后新增：

```typescript
// 目录树子项计数：每个 folder 的直接子 folder / 子 file 数（parent_id 即 folder id）
export function folderChildCounts(ownerId: string): Map<string, { folders: number; files: number }> {
    const rows = db.select({
        parentId: schema.documents.parentId,
        type: schema.documents.type,
        cnt: sql<number>`count(*)`
    }).from(schema.documents)
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            isNotNull(schema.documents.parentId)
        ))
        .groupBy(schema.documents.parentId, schema.documents.type)
        .all() as { parentId: string; type: string; cnt: number }[];
    const out = new Map<string, { folders: number; files: number }>();
    for (const r of rows) {
        const entry = out.get(r.parentId) ?? { folders: 0, files: 0 };
        if (r.type === 'folder') entry.folders = r.cnt;
        else entry.files = r.cnt;
        out.set(r.parentId, entry);
    }
    return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/documents.test.ts -t folderChildCounts`
Expected: PASS（3 个用例全绿）

- [ ] **Step 5: 全量回归**

Run: `bun run test apps/web/tests/documents.test.ts`
Expected: PASS（既有用例不受影响）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/server/documents.ts apps/web/tests/documents.test.ts
git commit -m "feat(web): documents 增 folderChildCounts——按 parent 聚合直接子文件夹/文件数"
```

---

### Task 2: 纯函数 `folder-tree.ts`（祖先链 + 折叠过滤）

**Files:**
- Create: `apps/web/src/lib/shared/folder-tree.ts`
- Test: Create: `apps/web/tests/folder-tree.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `apps/web/tests/folder-tree.test.ts`：

```typescript
import { test, expect } from 'vitest';
import { ancestorsOf, visibleNodes, type TreeFolder } from '../src/lib/shared/folder-tree';

function f(id: string, parentId: string | null, childFolders = 0, childFiles = 0): TreeFolder {
    return { id, name: id, parentId, childFolders, childFiles };
}

// 树形：a(根) → b → c → d；e(根，独立)
function fixture(): TreeFolder[] {
    return [
        f('a', null, 1, 0),
        f('b', 'a', 1, 0),
        f('c', 'b', 1, 1),
        f('d', 'c', 0, 2),
        f('e', null, 0, 3)
    ];
}

test('ancestorsOf 返回自顶向下祖先链（不含自身）', () => {
    expect(ancestorsOf(fixture(), 'd')).toEqual(['a', 'b', 'c']);
    expect(ancestorsOf(fixture(), 'b')).toEqual(['a']);
});

test('ancestorsOf 顶层节点返回空数组', () => {
    expect(ancestorsOf(fixture(), 'a')).toEqual([]);
});

test('ancestorsOf 不存在的 id 返回空数组', () => {
    expect(ancestorsOf(fixture(), 'nope')).toEqual([]);
});

test('ancestorsOf parentId 环（脏数据）不死循环', () => {
    const cyc = [
        f('x', 'y'),
        f('y', 'x'),
        f('child', 'x')
    ];
    expect(() => ancestorsOf(cyc, 'child')).not.toThrow();
    // 深度上限截断后返回（内容不断言，只保证不挂）
});

test('visibleNodes 全折叠：仅顶层可见', () => {
    const out = visibleNodes(fixture(), new Set());
    expect(out.map(n => n.id)).toEqual(['a', 'e']);
});

test('visibleNodes 展开 a：a 的孩子可见、孙不可见', () => {
    const out = visibleNodes(fixture(), new Set(['a']));
    expect(out.map(n => n.id)).toEqual(['a', 'b', 'e']);
});

test('visibleNodes 多级全展开：全部可见且 depth 正确', () => {
    const out = visibleNodes(fixture(), new Set(['a', 'b', 'c']));
    expect(out.map(n => n.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(out.map(n => n.depth)).toEqual([0, 1, 2, 3, 0]);
});

test('visibleNodes 孤儿节点（父不在集合）不渲染', () => {
    const orphans = [...fixture(), f('ghost', 'missing-parent')];
    const out = visibleNodes(orphans, new Set(['a', 'b', 'c']));
    expect(out.some(n => n.id === 'ghost')).toBe(false);
});

test('visibleNodes 展开集含已删 id（脏 localStorage）无影响', () => {
    const out = visibleNodes(fixture(), new Set(['deleted-id']));
    expect(out.map(n => n.id)).toEqual(['a', 'e']);
});

test('visibleNodes 保留子项计数字段', () => {
    const out = visibleNodes(fixture(), new Set());
    const d = out.find(n => n.id === 'e');
    expect(d?.childFiles).toBe(3);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/folder-tree.test.ts`
Expected: FAIL（模块不存在：Cannot find module '../src/lib/shared/folder-tree'）

- [ ] **Step 3: 实现**

创建 `apps/web/src/lib/shared/folder-tree.ts`（与 `theme.ts` 同层，纯前端共享、无 server 依赖）：

```typescript
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/folder-tree.test.ts`
Expected: PASS（10 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/shared/folder-tree.ts apps/web/tests/folder-tree.test.ts
git commit -m "feat(web): 目录树纯函数 folder-tree——祖先链/折叠过滤（防环+孤儿防御）"
```

---

### Task 3: load 接线 + `+page.svelte` 组装 + `FolderTree.svelte` 重写

**Files:**
- Modify: `apps/web/src/routes/+page.server.ts`（load 增加一个字段）
- Modify: `apps/web/src/routes/+page.svelte`（组装 TreeFolder[] + storageKey + 传 props）
- Modify: `apps/web/src/lib/components/FolderTree.svelte`（整体重写）

- [ ] **Step 1: load 增加 folderCounts**

`apps/web/src/routes/+page.server.ts`：

import 行（L6）改为：

```typescript
import { deleteNode, listChildren, listFolders, folderChildCounts, moveNode, renameNode } from '$server/documents';
```

load 返回值（L25）改为：

```typescript
    return { children, folders, currentDir, tagsByDoc, allTags: listTags(locals.user.id), folderCounts: folderChildCounts(locals.user.id) };
```

（Map 经 devalue 序列化无碍，`tagsByDoc` 已有先例。）

- [ ] **Step 2: `+page.svelte` 组装 TreeFolder 与 storageKey**

`apps/web/src/routes/+page.svelte`：

script 顶部 import 区加：

```typescript
    import type { TreeFolder } from '$lib/shared/folder-tree';
```

`let rightPane = ...` 之后加（`$derived` 表达式写法，直接写函数调用结果）：

```typescript
    // 组装目录树入参：folder 行 + 直接子项计数合成 TreeFolder（组件不感知后端结构，spec §5.1）
    const treeFolders = $derived<TreeFolder[]>(
        data.folders.map(fr => {
            const c = data.folderCounts.get(fr.id) ?? { folders: 0, files: 0 };
            return { id: fr.id, name: fr.name, parentId: fr.parentId, childFolders: c.folders, childFiles: c.files };
        })
    );
```

`<aside class="fm-left">` 内组件调用改为：

```svelte
        <FolderTree
            folders={treeFolders}
            currentId={currentDir}
            selecting={movingId !== null}
            onSelect={movingId !== null ? pickTarget : selectDir}
            storageKey="rr:tree-expanded:{data.user?.id ?? 'anon'}"
        />
```

- [ ] **Step 3: 重写 `FolderTree.svelte`**

整体替换 `apps/web/src/lib/components/FolderTree.svelte`：

```svelte
<script lang="ts">
    import { untrack } from 'svelte';
    import { fade } from 'svelte/transition';
    import { ancestorsOf, visibleNodes, type TreeFolder } from '$lib/shared/folder-tree';

    let {
        folders,
        currentId = null as string | null,
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
        border: none; background: none; cursor: pointer; color: #57606a;
        border-radius: 4px; padding: 0;
    }
    .chevron svg { transition: transform 120ms ease; }
    .chevron.open svg { transform: rotate(90deg); }
    .chevron.placeholder { pointer-events: none; }
    .chevron:hover { background: #f6f8fa; color: #1f2328; }

    .label {
        flex: 1; min-width: 0;
        display: flex; align-items: center; gap: 0.35rem;
        border: none; background: none; cursor: pointer;
        padding: 0.3rem 0.4rem; border-radius: 4px;
        text-align: left; width: auto; color: #1f2328;
    }
    .label:hover { background: #f6f8fa; }
    .label.active { background: #ddf4ff; font-weight: 600; }
    .label.pick { background: #dafbe1; outline: 2px solid #2da44e; }
    .label:focus-visible, .chevron:focus-visible { outline: 2px solid #0969da; outline-offset: -1px; }

    .folder-icon { flex-shrink: 0; color: #54aeff; }
    .label.root .folder-icon { color: #57606a; }

    .name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .count { margin-left: auto; flex-shrink: 0; color: #57606a; font-size: 0.72rem; font-variant-numeric: tabular-nums; }
</style>
```

**图标说明**：根目录行用 home octicon；文件夹行折叠态 folder / 展开态 folder-open（均内联 SVG，GitHub 调性）。

- [ ] **Step 4: 类型检查**

Run: `bun --filter remote-reader-web check`
Expected: 0 errors, 0 warnings（新增代码无类型错）

- [ ] **Step 5: 全量测试回归**

Run: `bun run test`
Expected: 全绿（294+ 用例，folder-tree 10 个新用例 + documents 3 个新用例）

- [ ] **Step 6: 手动冒烟（dev + 浏览器 / Playwright）**

```bash
bun --filter remote-reader-web dev
```

准备数据（已有账号 + API token 则用之；否则走 `/register` + `node scripts/seed-token.mjs <email>`）：

```bash
curl -X POST http://localhost:5173/api/v1/documents -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"l1.md","content":"# 1","path":"a"}'
curl -X POST http://localhost:5173/api/v1/documents -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"l2.md","content":"# 2","path":"a/b"}'
curl -X POST http://localhost:5173/api/v1/documents -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" -d '{"name":"l3.md","content":"# 3","path":"a/b/c"}'
```

浏览器（或 Playwright MCP）登录后验证清单（spec §7.4）：

1. 首次进入 `/`：左树只显示顶层文件夹 `a`（折叠态、chevron 朝右、计数 **2**）
2. 点 chevron：展开子级、chevron 旋转 90°、新行 80ms 淡入；**不发生导航**（右栏不变）
3. 点文件夹名 `a`：导航进 `/?dir=<a>`，右栏变子项，左树 `a` 行蓝底高亮
4. 刷新页面：展开状态恢复（localStorage 记忆）
5. 直接访问深链 `/?dir=<c 的 id>`（从右栏逐层点进 a→b→c）：祖先链 a、b 自动展开、c 高亮
6. 移动模式：对任意文档点"移动到…"，左树出现绿框 pick 态，点目标文件夹完成移动、hint 消失；期间 chevron 仍可折叠
7. 折叠回弹验证（关键）：仍位于 c 内，点 `a` 的 chevron 折叠 → a 及其子孙立即收起、**不回弹**；随后在右栏新建一个文件夹（触发 invalidateAll 刷新数据）→ a 仍保持折叠、不回弹
8. 回到根目录，"新建文件夹"建 `tmp`：树上出现 `tmp`（整行 opacity 0.6、无 chevron、无计数——空文件夹淡化）
9. 删除 `tmp`：从树上消失；刷新后 localStorage 中残留的已删 id 不影响渲染（树仍正常）
10. 计数正确：`a` 行显示 **2**（1 个子文件夹 b + 1 个文件 l1.md）、hover title "1 个子文件夹 · 1 个文件"；`b` 行显示 **2**（1 个子文件夹 c + 1 个文件 l2.md）
11. Tab 键盘：焦点环出现，Enter 触发对应按钮（chevron 展开 / 名字导航）
12. 窄屏（<768px 视口）：左树纵向置顶限高滚动正常，折叠后不再占满

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/routes/+page.server.ts apps/web/src/routes/+page.svelte apps/web/src/lib/components/FolderTree.svelte
git commit -m "feat(web): 文件管理器目录树产品级改造——折叠展开/状态记忆/自动定位/计数/SVG 视觉"
```

---

### Task 4: 收尾——文档状态同步

**Files:**
- Modify: `docs/superpowers/specs/2026-09-07-folder-tree-polish-design.md`（§9）
- Modify: `CLAUDE.md`（当前状态段）

- [ ] **Step 1: spec §9 状态更新**

```markdown
## 9. 实现现状

- 2026-09-07：spec 定稿，未实现。
```

改为：

```markdown
## 9. 实现现状

- 2026-09-07：spec 定稿，未实现。
- 2026-09-07：已实现并 merge `master`——folderChildCounts 聚合、folder-tree 纯函数（10 用例）、FolderTree 折叠/记忆/自动定位/计数/SVG 视觉重写；全量测试 + svelte-check 0 错 + 手动冒烟通过。
```

- [ ] **Step 2: CLAUDE.md 当前状态段补一句**

在「当前状态」第一段末尾（`259 单测 + svelte-check 0 错…` 所在句之后）补：

```markdown
后续已交付：文件管理器目录树产品级改造（折叠/展开 + localStorage 按用户记忆 + 当前路径自动展开定位 + 直接子项计数 + SVG 图标/a11y；树逻辑提取纯函数 `apps/web/src/lib/shared/folder-tree.ts` 单测覆盖）。
```

（若该段已有"后续已交付"列表，追加到列表合适位置，保持行文一致。）

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-09-07-folder-tree-polish-design.md CLAUDE.md
git commit -m "docs: 目录树改造实现状态同步——spec §9 翻转 + CLAUDE.md 当前状态补充"
```

---

## 验证总表（执行完毕后逐项核对）

- [ ] `bun run test` 全绿（含 folder-tree.test.ts 10 用例、documents.test.ts +3 用例）
- [ ] `bun --filter remote-reader-web check` 0 错
- [ ] spec §7.4 手动冒烟 12 项全过
- [ ] 4 个 commit 落库、工作区干净（`git status` 无未跟踪的实现文件）
