# 子计划 3 实现计划：管理 UI + Docker

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 Remote Reader 补齐用户侧管理 UI（文件管理器/token 管理/分享管理）+ owner 文档查看页 + logout + md 增强（mermaid/katex 懒加载）+ Docker 部署。

**Architecture:** 数据层在 `lib/server` 补同步 Drizzle 函数（TDD，vitest 在 node 下跑）；UI 用 SvelteKit form actions + load（双栏文件管理器，CSRF 内置）；md 增强在客户端 `onMount` 按需 dynamic import；Docker 多阶段（bun build → node run，better-sqlite3 原生编译）。

**Tech Stack:** SvelteKit 2 (Svelte 5 runes) · Drizzle ORM + better-sqlite3 · vitest · mermaid · katex · Docker。

**依据 spec:** `docs/superpowers/specs/2026-07-19-sub3-management-ui-docker-design.md`

**learning 模式约定（已按用户偏好调整）：** plan 原将 4 个有取舍的决策点标注 `【用户实现】`（moveNode 环路、deleteNode 级联、token 横幅 UX、mermaid 扫描）。但根据用户既有偏好（不写代码，learning 开放点也由 Claude 实现——见 memory `user-prefers-claude-implements`），这些点**实际全部由 Claude（controller）提供实现**，不暂停请用户写。plan 仍保留 `【用户实现】` 标注作为"此处有设计取舍"的记号，但实现代码由 controller 在派发 implementer 时一并给出。其余 step 给完整代码。

---

## 文件结构总览

### 数据层（`apps/web/src/lib/server`）
- Modify: `documents.ts` — 加 `listChildren` / `listFolders` / `getOwnedDocument` / `renameNode` / `moveNode` / `deleteNode`
- Modify: `shares.ts` — 加 `listSharesByOwner` / `revokeShare`
- Create: `apitokens.ts` — `listTokens` / `createTokenForUser` / `revokeToken`
- Modify: `markdown.ts` — mermaid fence 跳过 shiki + katex 占位规则

### 组件（`apps/web/src/lib/components`）
- Create: `FolderTree.svelte` — 左栏递归目录树（兼移动目标选择器）
- Create: `FileManager.svelte` — 右栏列表 + 行内操作
- Modify: `MarkdownViewer.svelte` — 加客户端 mermaid/katex 懒加载

### 路由（`apps/web/src/routes`）
- Modify: `+layout.svelte` — 顶部导航栏
- Modify: `+page.svelte` + Create `+page.server.ts`（`/`）— 文件管理器
- Create: `d/[id]/+page.server.ts` + `+page.svelte` — owner 文档查看
- Create: `settings/tokens/+page.server.ts` + `+page.svelte`
- Create: `settings/shares/+page.server.ts` + `+page.svelte`
- Create: `logout/+server.ts`

### 测试（`apps/web/tests`）
- Modify: `documents.test.ts` · `shares.test.ts` · `markdown.test.ts`
- Create: `apitokens.test.ts`

### 依赖 / Docker
- Modify: `apps/web/package.json` — 加 `mermaid`、`katex`
- Create: `Dockerfile` · `docker-compose.yml` · `.dockerignore`

---

## Phase 1：数据层（lib/server）

### Task 1: documents 读取函数（listChildren / listFolders / getOwnedDocument）

**Files:**
- Modify: `apps/web/src/lib/server/documents.ts`（在文件末尾追加）
- Modify: `apps/web/tests/documents.test.ts`（追加 import + 测试块）

- [ ] **Step 1: 在测试文件追加 import**

`apps/web/tests/documents.test.ts` 第 8 行 `import { uploadDocument }` 改为：

```ts
import {
    uploadDocument,
    listChildren,
    listFolders,
    getOwnedDocument,
    renameNode,
    moveNode,
    deleteNode
} from '../src/lib/server/documents';
```

- [ ] **Step 2: 追加测试块**（在文件末尾）

```ts
test('listChildren 返回指定 folder 的子项', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['reports']);
    await uploadDocument(ownerId, 'b.md', 'y', ['reports']);
    const reports = db.select().from(schema.documents)
        .where(and(eq(schema.documents.name, 'reports'), eq(schema.documents.type, 'folder'))).get();
    const children = listChildren(ownerId, reports!.id);
    expect(children.length).toBe(2);
});

test('listFolders 返回 owner 的所有 folder', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['reports']);
    await uploadDocument(ownerId, 'b.md', 'y', ['notes']);
    expect(listFolders(ownerId).length).toBe(2);
});

test('getOwnedDocument 仅返回属于该 owner 的文档', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    expect(getOwnedDocument(r.id, ownerId)).toBeTruthy();
    expect(getOwnedDocument(r.id, 'other-user')).toBeUndefined();
});
```

> 注：测试文件顶部已 `import { eq } from 'drizzle-orm'`，需补 `and`：把第 9 行改为 `import { eq, and } from 'drizzle-orm';`

- [ ] **Step 3: 跑测试确认失败**

Run: `bun run test apps/web/tests/documents.test.ts -t "listChildren"`
Expected: FAIL（函数未导出）

- [ ] **Step 4: 实现**（追加到 `documents.ts` 末尾）

```ts
export function listChildren(ownerId: string, parentId: string | null) {
    return db.select().from(schema.documents)
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            parentId === null
                ? isNull(schema.documents.parentId)
                : eq(schema.documents.parentId, parentId)
        ))
        .all();
}

export function listFolders(ownerId: string) {
    return db.select().from(schema.documents)
        .where(and(
            eq(schema.documents.ownerId, ownerId),
            eq(schema.documents.type, 'folder')
        ))
        .all();
}

export function getOwnedDocument(id: string, ownerId: string) {
    return db.select().from(schema.documents)
        .where(and(
            eq(schema.documents.id, id),
            eq(schema.documents.ownerId, ownerId)
        ))
        .get();
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run test apps/web/tests/documents.test.ts`
Expected: PASS（含新增 3 个测试）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/server/documents.ts apps/web/tests/documents.test.ts
git commit -m "feat(sub3): documents read helpers (list/folders/getOwned)"
```

---

### Task 2: documents renameNode + moveNode（含环路检测）

**Files:**
- Modify: `apps/web/src/lib/server/documents.ts`
- Modify: `apps/web/tests/documents.test.ts`

- [ ] **Step 1: 追加测试块**（文件末尾；含两个查询 helper）

```ts
function folderByName(name: string) {
    return db.select().from(schema.documents)
        .where(and(eq(schema.documents.name, name), eq(schema.documents.type, 'folder')))
        .get();
}
function docByName(name: string) {
    return db.select().from(schema.documents)
        .where(and(eq(schema.documents.name, name), eq(schema.documents.type, 'file')))
        .get();
}

test('renameNode 修改名称', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    expect(renameNode(ownerId, r.id, 'renamed.md')).toBe(true);
    const row = db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get();
    expect(row?.name).toBe('renamed.md');
});

test('renameNode 非 owner 返回 false 不生效', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    expect(renameNode('other', r.id, 'renamed.md')).toBe(false);
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()?.name).toBe('a.md');
});

test('moveNode 移到另一 folder', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['src']);
    await uploadDocument(ownerId, 'b.md', 'y', ['dst']);
    const dst = folderByName('dst')!;
    const a = docByName('a.md')!;
    const r = moveNode(ownerId, a.id, dst.id);
    expect(r.ok).toBe(true);
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, a.id)).get()?.parentId).toBe(dst.id);
});

test('moveNode 拒绝移入自身子孙（防环路）', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['p', 'c']);
    const p = folderByName('p')!;
    const c = folderByName('c')!;
    const r = moveNode(ownerId, p.id, c.id);
    expect(r.ok).toBe(false);
    expect(r.reason).toBeTruthy();
});

test('moveNode 非 owner 拒绝', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['dst']);
    const dst = folderByName('dst')!;
    const a = docByName('a.md')!;
    expect(moveNode('other', a.id, dst.id).ok).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/documents.test.ts -t "renameNode"`
Expected: FAIL（函数未导出）

- [ ] **Step 3: 实现 renameNode**（追加到 `documents.ts`）

```ts
export function renameNode(ownerId: string, id: string, newName: string): boolean {
    const result = db.update(schema.documents)
        .set({ name: newName, updatedAt: Date.now() })
        .where(and(
            eq(schema.documents.id, id),
            eq(schema.documents.ownerId, ownerId)
        ))
        .run();
    return result.changes > 0;
}
```

- [ ] **Step 4: 实现 moveNode — 【用户实现】**

在 `documents.ts` 追加函数。**签名固定**（测试依赖它）：

```ts
export function moveNode(
    ownerId: string,
    id: string,
    newParentId: string | null
): { ok: boolean; reason?: string } {
    // 【用户实现】约束（测试已锁定行为）：
    // 1. 查目标节点，必须存在且 ownerId 匹配，否则 { ok: false }
    // 2. newParentId === id → { ok: false, reason: '目标与自身相同' }
    // 3. 环路检测：从 newParentId 沿 parentId 上溯（循环 .get()），
    //    若中途遇到 id → { ok: false, reason: '不能移入自身子孙' }
    //    （newParentId === null 表示根，无环路）
    // 4. 校验 newParentId 若非 null 必须是 owner 的 folder，否则 { ok: false }
    // 5. 通过 → db.update set { parentId: newParentId, updatedAt: now } → { ok: true }
    // 提示：drizzle 已 import eq/and/isNull；Date.now() 可用（运行时是 node）
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run test apps/web/tests/documents.test.ts`
Expected: PASS（含 rename/move 全部，含环路拒绝）

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/server/documents.ts apps/web/tests/documents.test.ts
git commit -m "feat(sub3): documents rename + move (cycle guard)"
```

---

### Task 3: documents deleteNode（级联删除）

**Files:**
- Modify: `apps/web/src/lib/server/documents.ts`
- Modify: `apps/web/tests/documents.test.ts`

- [ ] **Step 1: 追加测试块**

```ts
test('deleteNode 删 file 同时清 share_links', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    expect(db.select().from(schema.shareLinks).all().length).toBe(1);
    deleteNode(ownerId, r.id);
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()).toBeUndefined();
    expect(db.select().from(schema.shareLinks).all().length).toBe(0);
});

test('deleteNode 删 folder 级联删子孙', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', ['p', 'c']);
    const p = folderByName('p')!;
    deleteNode(ownerId, p.id);
    expect(db.select().from(schema.documents).all().length).toBe(0);
});

test('deleteNode 删 file 后磁盘文件删除', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    const doc = db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get();
    const path = doc!.storagePath!;
    deleteNode(ownerId, r.id);
    const { existsSync } = await import('node:fs');
    expect(existsSync(path)).toBe(false);
});

test('deleteNode 非 owner 不删', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    deleteNode('other', r.id);
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()).toBeTruthy();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/documents.test.ts -t "deleteNode"`
Expected: FAIL（函数未导出）

- [ ] **Step 3: 实现 deleteNode — 【用户实现】**

在 `documents.ts` 追加。**签名固定**：

```ts
export function deleteNode(ownerId: string, id: string): void {
    // 【用户实现】约束（测试已锁定行为）：
    // 1. 查节点，不存在或不属于 ownerId → 直接 return（不报错）
    // 2. 收集子树 id：循环队列，从 id 出发，每次查 parentId in 当前层的 children，累加到集合
    //    （含 id 自身、所有层级子孙 file+folder）
    // 3. db.transaction 内：
    //    a. 删 share_links where documentId in 子树（drizzle `inArray`，需 import）
    //    b. 删 documents where id in 子树
    // 4. 事务后（事务外）：遍历子树中 type==='file' 的 storagePath，
    //    用 `rm(storagePath, { recursive: true, force: true })` 尽力删，
    //    单个失败 console.warn 不抛（force:true 已容错文件不存在）
    // 提示：import { inArray } from 'drizzle-orm'; import { rm } from 'node:fs/promises';
    //       rm 是 async，但 deleteNode 同步签名——把磁盘删除用 rmSync from 'node:fs' 保持同步
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/documents.test.ts`
Expected: PASS（含级联、share 清理、磁盘删除、非 owner）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/documents.ts apps/web/tests/documents.test.ts
git commit -m "feat(sub3): documents cascade delete (db txn + disk cleanup)"
```

---

### Task 4: shares 扩展（listSharesByOwner / revokeShare）

**Files:**
- Modify: `apps/web/src/lib/server/shares.ts`
- Modify: `apps/web/tests/shares.test.ts`

- [ ] **Step 1: 追加 import + 测试块**

`shares.test.ts` 第 7-11 行 import 改为：

```ts
import {
    generateShareToken,
    createShareLink,
    getDocumentIdByShareToken,
    listSharesByOwner,
    revokeShare
} from '../src/lib/server/shares';
import { and, eq } from 'drizzle-orm';
```

文件末尾追加：

```ts
test('listSharesByOwner 返回 owner 文档的分享（含文档名）', async () => {
    const { token } = await createShareLink(docId);
    const list = listSharesByOwner(userId);
    expect(list.length).toBe(1);
    expect(list[0].token).toBe(token);
    expect(list[0].documentName).toBe('d.md');
});

test('listSharesByOwner 不返回他人文档的分享', async () => {
    await createShareLink(docId);
    expect(listSharesByOwner('other-user').length).toBe(0);
});

test('revokeShare 删除指定 token', async () => {
    const { token } = await createShareLink(docId);
    expect(revokeShare(userId, token)).toBe(true);
    expect(getDocumentIdByShareToken(token)).toBeNull();
});

test('revokeShare 非 owner 返回 false 不删', async () => {
    const { token } = await createShareLink(docId);
    expect(revokeShare('other-user', token)).toBe(false);
    expect(getDocumentIdByShareToken(token)).toBe(docId);
});
```

> 注：`shares.test.ts` 的 beforeEach 里用户 id 存在局部变量但未导出为 `userId`——需把 beforeEach 里 `const userId = generateId()` 改为模块级 `let userId: string;` 并赋值（参照 documents.test.ts 的 ownerId 模式）。

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/shares.test.ts -t "listSharesByOwner"`
Expected: FAIL（函数未导出）

- [ ] **Step 3: 实现**（追加到 `shares.ts`）

```ts
import { and } from 'drizzle-orm';

export function listSharesByOwner(ownerId: string) {
    return db.select({
        token: schema.shareLinks.token,
        documentId: schema.shareLinks.documentId,
        documentName: schema.documents.name,
        createdAt: schema.shareLinks.createdAt,
        expiresAt: schema.shareLinks.expiresAt
    }).from(schema.shareLinks)
        .innerJoin(schema.documents, eq(schema.shareLinks.documentId, schema.documents.id))
        .where(eq(schema.documents.ownerId, ownerId))
        .all();
}

export function revokeShare(ownerId: string, token: string): boolean {
    const link = db.select({ id: schema.shareLinks.id })
        .from(schema.shareLinks)
        .innerJoin(schema.documents, eq(schema.shareLinks.documentId, schema.documents.id))
        .where(and(
            eq(schema.shareLinks.token, token),
            eq(schema.documents.ownerId, ownerId)
        ))
        .get();
    if (!link) return false;
    db.delete(schema.shareLinks).where(eq(schema.shareLinks.id, link.id)).run();
    return true;
}
```

> 注：`and` 需在文件顶部 import（shares.ts 现有 import 只有 `eq`）。把 `import { eq } from 'drizzle-orm'` 改为 `import { eq, and } from 'drizzle-orm'`，删除上面重复的 `import { and }`。

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/shares.test.ts`
Expected: PASS（含新增 4 个测试）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/lib/server/shares.ts apps/web/tests/shares.test.ts
git commit -m "feat(sub3): shares list-by-owner + revoke"
```

---

### Task 5: apitokens 新模块（listTokens / createTokenForUser / revokeToken）

**Files:**
- Create: `apps/web/src/lib/server/apitokens.ts`
- Create: `apps/web/tests/apitokens.test.ts`

- [ ] **Step 1: 写测试文件**

```ts
import { test, expect, beforeAll, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/server/db';
import { generateId, hashPassword, hashToken } from '../src/lib/server/auth';
import { listTokens, createTokenForUser, revokeToken } from '../src/lib/server/apitokens';

const here = dirname(fileURLToPath(import.meta.url));
const migrationsFolder = join(here, '../src/lib/server/db/migrations');

let userId: string;

beforeAll(() => {
    migrate(db, { migrationsFolder });
});

beforeEach(async () => {
    db.delete(schema.apiTokens).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    userId = generateId();
    db.insert(schema.users).values({
        id: userId,
        email: `t-${Date.now()}@x.com`,
        passwordHash: await hashPassword('x'),
        role: 'member',
        createdAt: Date.now()
    }).run();
});

test('createTokenForUser 落库并返回明文一次', async () => {
    const { id, plaintext } = await createTokenForUser(userId, 'my-agent');
    expect(id).toBeTruthy();
    expect(plaintext).toMatch(/^rr_/);
    const row = db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, id)).get();
    expect(row?.name).toBe('my-agent');
    expect(row?.tokenHash).toBe(hashToken(plaintext));
    expect(row?.userId).toBe(userId);
});

test('listTokens 返回 owner 的 token（不含 hash）', async () => {
    await createTokenForUser(userId, 'a');
    await createTokenForUser(userId, 'b');
    const list = listTokens(userId);
    expect(list.length).toBe(2);
    expect(list[0]).not.toHaveProperty('tokenHash');
});

test('listTokens 不返回他人的 token', async () => {
    await createTokenForUser(userId, 'a');
    expect(listTokens('other-user').length).toBe(0);
});

test('revokeToken 删除指定 token', async () => {
    const { id } = await createTokenForUser(userId, 'a');
    expect(revokeToken(userId, id)).toBe(true);
    expect(db.select().from(schema.apiTokens).where(eq(schema.apiTokens.id, id)).get()).toBeUndefined();
});

test('revokeToken 非 owner 返回 false', async () => {
    const { id } = await createTokenForUser(userId, 'a');
    expect(revokeToken('other-user', id)).toBe(false);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `bun run test apps/web/tests/apitokens.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 apitokens.ts**

```ts
import { eq, and } from 'drizzle-orm';
import { db, schema } from './db';
import { generateId, generateApiToken } from './auth';

export function listTokens(ownerId: string) {
    return db.select({
        id: schema.apiTokens.id,
        name: schema.apiTokens.name,
        createdAt: schema.apiTokens.createdAt,
        lastUsedAt: schema.apiTokens.lastUsedAt
    }).from(schema.apiTokens)
        .where(eq(schema.apiTokens.userId, ownerId))
        .all();
}

export async function createTokenForUser(
    ownerId: string,
    name: string
): Promise<{ id: string; plaintext: string }> {
    const { plaintext, hash } = await generateApiToken();
    const id = generateId();
    db.insert(schema.apiTokens).values({
        id,
        userId: ownerId,
        name,
        tokenHash: hash,
        lastUsedAt: null,
        createdAt: Date.now()
    }).run();
    return { id, plaintext };
}

export function revokeToken(ownerId: string, id: string): boolean {
    const result = db.delete(schema.apiTokens)
        .where(and(
            eq(schema.apiTokens.id, id),
            eq(schema.apiTokens.userId, ownerId)
        ))
        .run();
    return result.changes > 0;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `bun run test apps/web/tests/apitokens.test.ts`
Expected: PASS（全部 5 个测试）

- [ ] **Step 5: 跑全量 + svelte-check**

Run: `bun run test && bun --filter remote-reader-web check`
Expected: 全部测试通过（74 → ~90），svelte-check 0 错

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/server/apitokens.ts apps/web/tests/apitokens.test.ts
git commit -m "feat(sub3): apitokens module (list/create/revoke)"
```

---

## Phase 2：导航 + logout + 文件管理器

> **结构微调：** 文件管理器右栏逻辑直接放 `/+page.svelte`（与 actions 耦合紧密），不再单独建 `FileManager.svelte`。仅 `FolderTree.svelte` 独立组件（左栏树，复用性强）。原 file structure 的 `FileManager.svelte` 取消。

### Task 6: 顶部导航 + logout

**Files:**
- Create: `apps/web/src/routes/logout/+server.ts`
- Modify: `apps/web/src/routes/+layout.svelte`

- [ ] **Step 1: 写 logout 端点**

`apps/web/src/routes/logout/+server.ts`：

```ts
import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clearSessionCookie } from '$server/session';

export const POST: RequestHandler = async ({ cookies }) => {
    clearSessionCookie(cookies);
    redirect(303, '/');
};
```

> CSRF：SvelteKit 默认 `csrf.checkOrigin = true`，对所有非 GET 请求（含提交到 `+server.ts` 的 form）做 origin 校验，登出 form 受保护。

- [ ] **Step 2: 改造 +layout.svelte**

整体替换 `apps/web/src/routes/+layout.svelte`：

```svelte
<script lang="ts">
    import { page } from '$app/stores';
    let { data, children } = $props();
    const showNav = $derived(
        !!data.user &&
        !($page.url.pathname === '/login' ||
          $page.url.pathname === '/register' ||
          $page.url.pathname.startsWith('/s/'))
    );
</script>

{#if showNav}
<header class="topnav">
    <a href="/">我的文档</a>
    <details>
        <summary>设置</summary>
        <div class="menu">
            <a href="/settings/tokens">API Token</a>
            <a href="/settings/shares">分享链接</a>
        </div>
    </details>
    <span class="email">{data.user?.email}</span>
    <form method="POST" action="/logout">
        <button type="submit">登出</button>
    </form>
</header>
{/if}

<main>
    {@render children()}
</main>

<style>
    .topnav {
        display: flex; gap: 1.25rem; align-items: center;
        padding: 0.75rem 1.5rem; border-bottom: 1px solid #d0d7de;
        font-family: system-ui, sans-serif;
    }
    .topnav details { position: relative; }
    .topnav details summary { cursor: pointer; }
    .topnav .menu {
        position: absolute; top: 100%; left: 0; background: #fff;
        border: 1px solid #d0d7de; display: flex; flex-direction: column;
        padding: 0.25rem 0; min-width: 9rem; z-index: 10;
    }
    .topnav .menu a { padding: 0.4rem 0.75rem; text-decoration: none; color: #1f2328; }
    .topnav .menu a:hover { background: #f6f8fa; }
    .topnav .email { color: #57606a; margin-left: auto; }
</style>
```

- [ ] **Step 3: svelte-check**

Run: `bun --filter remote-reader-web check`
Expected: 0 错

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/logout/+server.ts apps/web/src/routes/+layout.svelte
git commit -m "feat(sub3): top nav + logout route"
```

---

### Task 7: `/` load + FolderTree 组件 + 文件管理器骨架

**Files:**
- Create: `apps/web/src/routes/+page.server.ts`（仅 load）
- Create: `apps/web/src/lib/components/FolderTree.svelte`
- Modify: `apps/web/src/routes/+page.svelte`（整体替换占位首页）

- [ ] **Step 1: 写 /+page.server.ts 的 load**

`apps/web/src/routes/+page.server.ts`：

```ts
import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { listChildren, listFolders } from '$server/documents';

export const load: PageServerLoad = async ({ locals, url }) => {
    if (!locals.user) redirect(302, '/login');
    const dir = url.searchParams.get('dir');
    const parentId = dir && dir.length > 0 ? dir : null;
    const children = listChildren(locals.user.id, parentId);
    const folders = listFolders(locals.user.id);
    return { children, folders, currentDir: parentId };
};
```

- [ ] **Step 2: 写 FolderTree 组件**

`apps/web/src/lib/components/FolderTree.svelte`：

```svelte
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
```

- [ ] **Step 3: 整体替换 /+page.svelte（展示骨架，无操作按钮，Task 8-10 增量加）**

`apps/web/src/routes/+page.svelte`：

```svelte
<script lang="ts">
    import FolderTree from '$components/FolderTree.svelte';
    let { data } = $props();
    let currentDir = $state(data.currentDir);
    function goto(id: string | null) {
        currentDir = id;
        const url = new URL(location.href);
        if (id) url.searchParams.set('dir', id); else url.searchParams.delete('dir');
        history.pushState({}, '', url);
    }
</script>

<div class="fm">
    <aside class="fm-left">
        <FolderTree folders={data.folders} currentId={currentDir} onSelect={goto} />
    </aside>
    <section class="fm-right">
        <h1>{currentDir ? '子目录' : '根目录'}</h1>
        {#if data.children.length === 0}
            <p class="muted">空空如也。让 Agent 通过 MCP 上传文档吧。</p>
        {:else}
            <ul class="items">
                {#each data.children as item (item.id)}
                    <li>
                        {#if item.type === 'folder'}
                            <a href="/?dir={item.id}">📁 {item.name}</a>
                        {:else}
                            <a href="/d/{item.id}">📄 {item.name}</a>
                            <span class="size">{item.sizeBytes} B</span>
                        {/if}
                    </li>
                {/each}
            </ul>
        {/if}
    </section>
</div>

<style>
    .fm { display: flex; gap: 1.5rem; padding: 1.5rem; font-family: system-ui, sans-serif; }
    .fm-left { width: 16rem; flex-shrink: 0; border-right: 1px solid #d0d7de; padding-right: 1rem; }
    .fm-right { flex: 1; }
    .items { list-style: none; padding: 0; }
    .items li { padding: 0.5rem 0; display: flex; align-items: center; gap: 0.75rem; }
    .items a { color: #0969da; text-decoration: none; }
    .items a:hover { text-decoration: underline; }
    .size { color: #57606a; font-size: 0.85em; }
    .muted { color: #57606a; }
</style>
```

> 注：`$components` alias 已配（见 CLAUDE.md）。`goto` 用 `history.pushState` + 后续 `invalidateAll` 切换；Task 8 起表单提交用 `use:enhance` 统一刷新数据。

- [ ] **Step 4: 冒烟**

Run: `bun --filter remote-reader-web dev` → 登录 → 访问 `/`，应见双栏（左树、右列表）；`bun --filter remote-reader-web check` 0 错。

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/+page.server.ts apps/web/src/lib/components/FolderTree.svelte apps/web/src/routes/+page.svelte
git commit -m "feat(sub3): file manager dual-pane skeleton (/)"
```

---

### Task 8: createFolder + rename

**Files:**
- Modify: `apps/web/src/routes/+page.server.ts`（加 actions）
- Modify: `apps/web/src/routes/+page.svelte`（加表单 UI）

- [ ] **Step 1: 给 +page.server.ts 加 actions**

在 `+page.server.ts` 末尾追加（import 补 `error`、`and`、`eq`、`generateId`、`db`、`schema`、`renameNode`）：

```ts
import { error } from '@sveltejs/kit';
import type { Actions } from './$types';
import { and, eq } from 'drizzle-orm';
import { generateId } from '$server/auth';
import { db, schema } from '$server/db';
import { renameNode } from '$server/documents';

export const actions: Actions = {
    createFolder: async ({ request, locals, url }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const name = String(form.get('name') ?? '').trim();
        const dir = url.searchParams.get('dir');
        const parentId = dir && dir.length > 0 ? dir : null;
        if (!name) error(400, '名称必填');
        const dup = db.select().from(schema.documents).where(and(
            eq(schema.documents.ownerId, locals.user.id),
            parentId === null ? eq(schema.documents.parentId, parentId) : eq(schema.documents.parentId, parentId!),
            eq(schema.documents.name, name),
            eq(schema.documents.type, 'folder')
        )).get();
        if (!dup) {
            const now = Date.now();
            db.insert(schema.documents).values({
                id: generateId(), ownerId: locals.user.id, parentId, name,
                type: 'folder', storagePath: null, contentHash: null, sizeBytes: null,
                createdAt: now, updatedAt: now
            }).run();
        }
        return { ok: true };
    },
    rename: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const id = String(form.get('id') ?? '');
        const name = String(form.get('name') ?? '').trim();
        if (!id || !name) error(400, '参数缺失');
        renameNode(locals.user.id, id, name);
        return { ok: true };
    }
};
```

> 注：`parentId === null ? ... : eq(parentId, parentId!)` 的三元是为避免 drizzle 类型对 `null` 的报错；若 svelte-check 报错，改用上面 documents.ts 里 `isNull` 的同款写法（已 import 路径见 Task 1，需补 `isNull` 到此文件 import）。

- [ ] **Step 2: +page.svelte 顶部加新建文件夹表单**

在 `/+page.svelte` `<script>` 内补 import：`import { enhance } from '$app/forms'; import { invalidateAll } from '$app/navigation';`，并把 `goto` 内的 `history.pushState` 后追加 `await invalidateAll();`（需改 goto 为 async）。

在 `<section class="fm-right">` 的 `<h1>` 之后插入：

```svelte
<form method="POST" action="?/createFolder" use:enhance={() => async ({ result }) => { if (result.type === 'success') await invalidateAll(); }}>
    <input name="name" placeholder="新文件夹名" required>
    <button>新建文件夹</button>
</form>
```

- [ ] **Step 3: +page.svelte 每行加 rename 表单**

把 `<li>` 内容改为（在 `{:else}` 的 size span 后追加）：

```svelte
{#if item.type === 'folder'}
    <a href="/?dir={item.id}">📁 {item.name}</a>
{:else}
    <a href="/d/{item.id}">📄 {item.name}</a>
    <span class="size">{item.sizeBytes} B</span>
{/if}
<form class="inline" method="POST" action="?/rename" use:enhance={() => async ({ result }) => { if (result.type === 'success') await invalidateAll(); }}>
    <input type="hidden" name="id" value={item.id}>
    <input name="name" value={item.name} required>
    <button>✏ 重命名</button>
</form>
```

并在 `<style>` 加 `.inline { display: inline-flex; gap: 0.25rem; margin-left: auto; }`

- [ ] **Step 4: 冒烟 + check**

Run: `bun --filter remote-reader-web check` → dev 验证新建文件夹/重命名生效
Expected: 0 错，操作后列表刷新

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/+page.server.ts apps/web/src/routes/+page.svelte
git commit -m "feat(sub3): file manager create-folder + rename"
```

---

### Task 9: move（左树选目标）

**Files:**
- Modify: `apps/web/src/routes/+page.server.ts`
- Modify: `apps/web/src/routes/+page.svelte`

- [ ] **Step 1: 加 move action**

在 `+page.server.ts` 的 `actions` 对象内追加（import 补 `moveNode`）：

```ts
import { moveNode } from '$server/documents';
// ...
move: async ({ request, locals }) => {
    if (!locals.user) redirect(302, '/login');
    const form = await request.formData();
    const id = String(form.get('id') ?? '');
    const target = String(form.get('target') ?? '');
    if (!id) error(400, '参数缺失');
    const newParentId = target === 'root' || !target ? null : target;
    const r = moveNode(locals.user.id, id, newParentId);
    if (!r.ok) error(400, r.reason ?? '移动失败');
    return { ok: true };
},
```

- [ ] **Step 2: +page.svelte 加"选目标"状态 + 移动表单**

`<script>` 加：

```ts
let movingId: string | null = $state(null);
function startMove(id: string) { movingId = id; }
async function pickTarget(targetId: string | null) {
    if (!movingId) return;
    const fd = new FormData();
    fd.set('id', movingId);
    fd.set('target', targetId ?? 'root');
    const r = await fetch('?/move', { method: 'POST', body: fd });
    if (r.ok) { movingId = null; await invalidateAll(); }
}
```

把 `<FolderTree>` 的调用改为（传 selecting + onSelect 分流）：

```svelte
<FolderTree
    folders={data.folders}
    currentId={currentDir}
    selecting={movingId !== null}
    onSelect={movingId !== null ? pickTarget : goto}
/>
```

每个 `<li>` 在 rename 表单后加移动按钮：

```svelte
{#if movingId === item.id}
    <span class="hint">← 在左树点选目标</span>
    <button onclick={() => (movingId = null)}>取消</button>
{:else}
    <button class="inline-btn" onclick={() => startMove(item.id)}>📂 移动</button>
{/if}
```

`<style>` 加 `.hint { color: #2da44e; } .inline-btn { margin-left: 0.5rem; }`

- [ ] **Step 3: 冒烟 + check**

Run: `bun --filter remote-reader-web check` → dev 验证：点移动 → 左树变绿 → 点目标 → 文件移走；尝试移入自身子文件夹应报错（moveNode 环路拒绝）。
Expected: 0 错，移动生效，环路被拒

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/+page.server.ts apps/web/src/routes/+page.svelte
git commit -m "feat(sub3): file manager move (left-tree target picker)"
```

---

### Task 10: delete

**Files:**
- Modify: `apps/web/src/routes/+page.server.ts`
- Modify: `apps/web/src/routes/+page.svelte`

- [ ] **Step 1: 加 delete action**

在 `actions` 内追加（import 补 `deleteNode`）：

```ts
import { deleteNode } from '$server/documents';
// ...
delete: async ({ request, locals }) => {
    if (!locals.user) redirect(302, '/login');
    const form = await request.formData();
    const id = String(form.get('id') ?? '');
    if (!id) error(400, '参数缺失');
    deleteNode(locals.user.id, id);
    return { ok: true };
},
```

- [ ] **Step 2: +page.svelte 每行加删除表单（带 confirm）**

每个 `<li>` 在移动按钮后追加：

```svelte
<form class="inline" method="POST" action="?/delete"
    use:enhance={({ cancel }) => { if (!confirm('确认删除？文件夹会级联删除全部内容，且不可恢复。')) cancel(); }}
>
    <input type="hidden" name="id" value={item.id}>
    <button>🗑 删除</button>
</form>
```

- [ ] **Step 3: 冒烟 + check**

Run: `bun --filter remote-reader-web check` → dev 验证删 file（share 链接同步失效）、删 folder（级联）
Expected: 0 错，删除生效

- [ ] **Step 4: 全量测试**

Run: `bun run test`
Expected: 全过（lib 层测试不受 UI 影响）

- [ ] **Step 5: Commit**

```bash
git add apps/web/src/routes/+page.server.ts apps/web/src/routes/+page.svelte
git commit -m "feat(sub3): file manager delete (confirm + cascade)"
```

---

## Phase 3：/d/[id] + token 管理 + 分享管理

### Task 11: /d/[id] owner 文档查看页

**Files:**
- Create: `apps/web/src/routes/d/[id]/+page.server.ts`
- Create: `apps/web/src/routes/d/[id]/+page.svelte`

- [ ] **Step 1: 写 load（owner 校验）**

`apps/web/src/routes/d/[id]/+page.server.ts`：

```ts
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getOwnedDocument } from '$server/documents';
import { readFile } from '$server/storage';
import { renderMarkdown } from '$server/markdown';

export const load: PageServerLoad = async ({ locals, params }) => {
    if (!locals.user) redirect(302, '/login');
    const doc = getOwnedDocument(params.id, locals.user.id);
    if (!doc || doc.type !== 'file' || !doc.storagePath) error(404, '文档不存在');
    const content = await readFile(doc.storagePath);
    const html = await renderMarkdown(content);
    return { title: doc.name, html };
};
```

> owner 校验在 `getOwnedDocument(id, ownerId)` 内完成（非 owner 返回 undefined → 404），不泄露他人文档存在性。

- [ ] **Step 2: 写 page（复用 MarkdownViewer）**

`apps/web/src/routes/d/[id]/+page.svelte`：

```svelte
<script lang="ts">
    import MarkdownViewer from '$components/MarkdownViewer.svelte';
    let { data } = $props();
</script>

<a href="/" class="back">← 返回我的文档</a>
<MarkdownViewer html={data.html} />

<style>
    .back { display: inline-block; padding: 1rem 1.5rem; font-family: system-ui, sans-serif; color: #0969da; text-decoration: none; }
</style>
```

- [ ] **Step 3: check + 冒烟**

Run: `bun --filter remote-reader-web check` → dev：从文件管理器点文件 → 看到渲染；访问他人文档 id → 404
Expected: 0 错

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/d/[id]/+page.server.ts apps/web/src/routes/d/[id]/+page.svelte
git commit -m "feat(sub3): /d/[id] owner document viewer"
```

---

### Task 12: /settings/tokens（load + revoke + create action）

**Files:**
- Create: `apps/web/src/routes/settings/tokens/+page.server.ts`
- Create: `apps/web/src/routes/settings/tokens/+page.svelte`

- [ ] **Step 1: 写 load + actions**

`apps/web/src/routes/settings/tokens/+page.server.ts`：

```ts
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { listTokens, createTokenForUser, revokeToken } from '$server/apitokens';

export const load: PageServerLoad = async ({ locals }) => {
    if (!locals.user) redirect(302, '/login');
    return { tokens: listTokens(locals.user.id) };
};

export const actions: Actions = {
    create: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const name = String(form.get('name') ?? '').trim();
        if (!name) error(400, '名称必填');
        const { plaintext } = await createTokenForUser(locals.user.id, name);
        return { plaintext };
    },
    revoke: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const id = String(form.get('id') ?? '');
        if (!id) error(400, '参数缺失');
        revokeToken(locals.user.id, id);
        return { ok: true };
    }
};
```

- [ ] **Step 2: 写 page（基础版，明文最简显示）**

`apps/web/src/routes/settings/tokens/+page.svelte`：

```svelte
<script lang="ts">
    import { enhance } from '$app/forms';
    let { data, form } = $props();
</script>

<h1>API Token 管理</h1>

{#if form?.plaintext}
<div class="reveal">
    <p>新 token（仅此一次显示，请立即保存）：</p>
    <code>{form.plaintext}</code>
</div>
{/if}

<form method="POST" action="?/create" use:enhance>
    <input name="name" placeholder="如 claude-code-laptop" required>
    <button>生成新 token</button>
</form>

<table>
    <thead><tr><th>名称</th><th>创建时间</th><th>最近使用</th><th></th></tr></thead>
    <tbody>
        {#each data.tokens as t (t.id)}
        <tr>
            <td>{t.name}</td>
            <td>{new Date(t.createdAt).toLocaleString()}</td>
            <td>{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleString() : '—'}</td>
            <td>
                <form method="POST" action="?/revoke"
                    use:enhance={({ cancel }) => { if (!confirm('撤销此 token？相关 Agent 将无法再认证。')) cancel(); }}>
                    <input type="hidden" name="id" value={t.id}>
                    <button>撤销</button>
                </form>
            </td>
        </tr>
        {/each}
    </tbody>
</table>

<style>
    :global(body) { font-family: system-ui, sans-serif; padding: 1.5rem; }
    .reveal { background: #fff8c5; border: 1px solid #d4a72c; padding: 1rem; border-radius: 6px; margin: 1rem 0; }
    .reveal code { word-break: break-all; }
    table { border-collapse: collapse; margin-top: 1rem; }
    th, td { border: 1px solid #d0d7de; padding: 0.4rem 0.8rem; text-align: left; }
</style>
```

- [ ] **Step 3: check + 冒烟**

Run: `bun --filter remote-reader-web check` → dev：生成 token → 见明文一次；刷新后明文消失；撤销生效
Expected: 0 错

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/settings/tokens/+page.server.ts apps/web/src/routes/settings/tokens/+page.svelte
git commit -m "feat(sub3): api token management page"
```

---

### Task 13: token 明文横幅 UX 增强 — 【用户实现】

**Files:**
- Modify: `apps/web/src/routes/settings/tokens/+page.svelte`（`.reveal` 块）

> 当前 `.reveal` 块只显示明文文本。这一步把它的交互体验做扎实——属于有取舍的 UX 决策，由用户亲手写。

- [ ] **Step 1: 实现 reveal 增强 — 【用户实现】**

替换 `.reveal` 块（`{#if form?.plaintext}…{/if}`）为用户设计的版本。**约束**：

- 必须显示 `form.plaintext`（字符串，形如 `rr_xxxx`）。
- 提供「复制」按钮：调用 `navigator.clipboard.writeText(form.plaintext)`，复制后给视觉反馈（如按钮文字短暂变成「已复制」）。
- 提供「关闭」按钮：点击后本地点击的横幅消失（用本地 `$state` 标记，如 `let dismissed = $state(false)`，`{#if form?.plaintext && !dismissed}`）。注意：刷新后 `form` 自然为空，dismissed 只管本次会话。
- 文案提醒"离开或刷新后不可再见"。
- 样式与现有 `.reveal`（黄底警告）协调。
- 纯客户端交互，无需改 action。

**验证**：dev 生成 token → 点复制 → 按钮反馈 → 粘贴到别处确认值正确 → 点关闭横幅消失。

- [ ] **Step 2: Commit**

```bash
git add apps/web/src/routes/settings/tokens/+page.svelte
git commit -m "feat(sub3): token reveal UX (copy + dismiss)"
```

---

### Task 14: /settings/shares（load + revoke）

**Files:**
- Create: `apps/web/src/routes/settings/shares/+page.server.ts`
- Create: `apps/web/src/routes/settings/shares/+page.svelte`

- [ ] **Step 1: 写 load + action**

`apps/web/src/routes/settings/shares/+page.server.ts`：

```ts
import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { listSharesByOwner, revokeShare } from '$server/shares';

export const load: PageServerLoad = async ({ locals }) => {
    if (!locals.user) redirect(302, '/login');
    return { shares: listSharesByOwner(locals.user.id) };
};

export const actions: Actions = {
    revoke: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const token = String(form.get('token') ?? '');
        if (!token) error(400, '参数缺失');
        revokeShare(locals.user.id, token);
        return { ok: true };
    }
};
```

- [ ] **Step 2: 写 page**

`apps/web/src/routes/settings/shares/+page.svelte`：

```svelte
<script lang="ts">
    import { enhance } from '$app/forms';
    let { data } = $props();
    function abbr(token: string) {
        return token.length > 8 ? `${token.slice(0, 4)}…${token.slice(-4)}` : token;
    }
</script>

<h1>分享链接</h1>

{#if data.shares.length === 0}
<p class="muted">暂无分享链接。Agent 上传文档时会自动生成。</p>
{:else}
<table>
    <thead><tr><th>文档</th><th>token</th><th>创建时间</th><th></th></tr></thead>
    <tbody>
        {#each data.shares as s (s.token)}
        <tr>
            <td>{s.documentName}</td>
            <td><code>{abbr(s.token)}</code></td>
            <td>{new Date(s.createdAt).toLocaleString()}</td>
            <td>
                <form method="POST" action="?/revoke"
                    use:enhance={({ cancel }) => { if (!confirm('撤销此分享链接？链接将立即失效。')) cancel(); }}>
                    <input type="hidden" name="token" value={s.token}>
                    <button>撤销</button>
                </form>
            </td>
        </tr>
        {/each}
    </tbody>
</table>
{/if}

<style>
    :global(body) { font-family: system-ui, sans-serif; padding: 1.5rem; }
    .muted { color: #57606a; }
    table { border-collapse: collapse; }
    th, td { border: 1px solid #d0d7de; padding: 0.4rem 0.8rem; text-align: left; }
</style>
```

- [ ] **Step 3: check + 冒烟**

Run: `bun --filter remote-reader-web check` → dev：有文档时列出分享 → 撤销 → `/s/<token>` 立即 404
Expected: 0 错，撤销生效

- [ ] **Step 4: Commit**

```bash
git add apps/web/src/routes/settings/shares/+page.server.ts apps/web/src/routes/settings/shares/+page.svelte
git commit -m "feat(sub3): share links management page"
```

---

## Phase 4：md 增强（Mermaid + KaTeX 懒加载）

### Task 15: 装依赖 + markdown.ts（mermaid 跳过 shiki + katex 占位规则）

**Files:**
- Modify: `apps/web/package.json`（加 mermaid、katex）
- Modify: `apps/web/src/lib/server/markdown.ts`
- Modify: `apps/web/tests/markdown.test.ts`

- [ ] **Step 1: 装依赖**

Run: `bun --filter remote-reader-web add mermaid katex`
Expected: package.json 增加两个依赖

- [ ] **Step 2: 追加测试**

`apps/web/tests/markdown.test.ts` 末尾追加（确保顶部已 `import { renderMarkdown } from '../src/lib/server/markdown'`）：

```ts
test('mermaid fence 输出 language-mermaid class 供客户端识别', async () => {
    const html = await renderMarkdown('```mermaid\ngraph TD; A-->B\n```');
    expect(html).toContain('language-mermaid');
});

test('inline $...$ 转为 math inline 占位 span', async () => {
    const html = await renderMarkdown('公式 $a+b$ 末尾');
    expect(html).toContain('class="math inline"');
    expect(html).toContain('a+b');
});

test('block $$...$$ 转为 math block 占位 div', async () => {
    const html = await renderMarkdown('$$\nx = y\n$$');
    expect(html).toContain('class="math block"');
    expect(html).toContain('x = y');
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `bun run test apps/web/tests/markdown.test.ts -t "mermaid fence"`
Expected: FAIL（math 规则未加；mermaid 当前会走 shiki catch 但有 console 噪音，测试可能因不含 math 而 mermaid 测试意外过——确认 math 测试 FAIL）

- [ ] **Step 4: 改 markdown.ts**

(a) `highlight` 函数开头加 mermaid 特判（避免 shiki 对 mermaid 报错 + console 噪音）：

```ts
highlight: (code, lang) => {
    if (lang === 'mermaid') return '';
    try {
        return hl.codeToHtml(code, { lang: lang || 'text', theme: THEME });
    } catch (e) {
        console.error('[markdown] shiki highlight failed for lang', lang, e);
        return '';
    }
}
```

(b) `renderMarkdown` 内 `return md.render(src)` **之前**插入规则注册（用 `any` 规避 markdown-it 类型摩擦）：

```ts
md.inline.ruler.before('escape', 'math_inline', (state: any, silent: boolean) => {
    if (state.src[state.pos] !== '$') return false;
    if (state.src[state.pos - 1] === '\\') return false;
    const close = state.src.indexOf('$', state.pos + 1);
    if (close === -1 || close === state.pos + 1) return false;
    const content = state.src.slice(state.pos + 1, close);
    if (content.includes('\n')) return false;
    if (!silent) {
        const tok = state.push('math_inline', 'span', 0);
        tok.markup = '$';
        tok.content = content;
    }
    state.pos = close + 1;
    return true;
});
md.block.ruler.before('fence', 'math_block', (state: any, startLine: number, endLine: number, silent: boolean) => {
    const start = state.bMarks[startLine] + state.tShift[startLine];
    if (start + 2 > state.eMarks[startLine]) return false;
    if (state.src.slice(start, start + 2) !== '$$') return false;
    if (silent) return true;
    let nextLine = startLine;
    while (nextLine < endLine) {
        nextLine++;
        const pos = state.bMarks[nextLine] + state.tShift[nextLine];
        if (state.src.slice(pos, pos + 2) === '$$') break;
    }
    if (nextLine >= endLine) return false;
    const contentStart = state.bMarks[startLine + 1];
    const contentEnd = state.eMarks[nextLine - 1];
    const tok = state.push('math_block', 'div', 0);
    tok.block = true;
    tok.markup = '$$';
    tok.content = state.src.slice(contentStart, contentEnd).trim();
    tok.map = [startLine, nextLine];
    state.line = nextLine + 1;
    return true;
});
md.renderer.rules.math_inline = (tokens: any, idx: number) =>
    `<span class="math inline">${md.utils.escapeHtml(tokens[idx].content)}</span>`;
md.renderer.rules.math_block = (tokens: any, idx: number) =>
    `<div class="math block">${md.utils.escapeHtml(tokens[idx].content)}</div>\n`;
```

- [ ] **Step 5: 跑测试确认通过**

Run: `bun run test apps/web/tests/markdown.test.ts`
Expected: PASS（含新增 3 个）

- [ ] **Step 6: Commit**

```bash
git add apps/web/package.json apps/web/src/lib/server/markdown.ts apps/web/tests/markdown.test.ts
git commit -m "feat(sub3): md enhancement — mermaid fence + katex math placeholders"
```

---

### Task 16: MarkdownViewer mermaid 懒加载 — 【用户实现】

**Files:**
- Modify: `apps/web/src/lib/components/MarkdownViewer.svelte`

- [ ] **Step 1: 实现 mermaid 客户端渲染 — 【用户实现】**

整体替换 `MarkdownViewer.svelte`，搭建骨架并把 `enhanceMermaid` 留给用户实现。**骨架**（必写）：

```svelte
<script lang="ts">
    import { onMount } from 'svelte';
    let { html }: { html: string } = $props();
    let container: HTMLDivElement;

    onMount(async () => {
        await enhanceMermaid(container);
        await enhanceKatex(container);
    });

    async function enhanceKatex(root: HTMLElement) {
        const nodes = Array.from(root.querySelectorAll<HTMLElement>('.math.inline, .math.block'));
        if (nodes.length === 0) return;
        const katex = (await import('katex')).default;
        for (const el of nodes) {
            try {
                el.innerHTML = katex.renderToString(el.textContent ?? '', {
                    displayMode: el.classList.contains('block'),
                    throwOnError: false
                });
            } catch (e) {
                console.warn('[katex] render failed', e);
            }
        }
    }

    async function enhanceMermaid(root: HTMLElement): Promise<void> {
        // 【用户实现】约束：
        // 1. 查找所有 mermaid 代码块：root.querySelectorAll('code.language-mermaid')
        // 2. 若无则直接 return（零下载）
        // 3. 动态 import：const mermaid = (await import('mermaid')).default;
        //    初始化 mermaid.initialize({ startOnLoad: false, theme: 'dark' })（仅首次）
        // 4. 把每个 code 块的 textContent 作为源，调用 await mermaid.run({ nodes })
        //    —— 参考做法：给每个 code 的父 pre 设置 id，或用 mermaid.render(id, code) 得 svg 后替换
        // 5. 降级：try/catch 包裹，失败时 console.warn 并保留原始 code 块（不阻断 katex）
        // 提示：mermaid 1.x 的 run 接收 { nodes: Element[] }；渲染前给元素加 class 'mermaid'
    }
</script>

<div class="markdown-body" bind:this={container}>
    {@html html}
</div>

<style>
    /* 保留现有 .markdown-body 全部样式，见原文件 */
</style>
```

> 注：`<style>` 保留原文件全部样式（复制过来）。`enhanceKatex` 已给完整实现，`enhanceMermaid` 由用户写。

- [ ] **Step 2: 冒烟**

Run: `bun --filter remote-reader-web dev` → 上传含 `` ```mermaid `` 和 `$E=mc^2$` 的 md → 查看页应渲染流程图和公式
Expected: mermaid 图与公式正常渲染；无图表/公式时不下载两库

- [ ] **Step 3: Commit**

```bash
git add apps/web/src/lib/components/MarkdownViewer.svelte
git commit -m "feat(sub3): client-side mermaid + katex lazy-load"
```

---

## Phase 5：Docker

### Task 17: Dockerfile + .dockerignore

**Files:**
- Create: `Dockerfile`
- Create: `.dockerignore`

- [ ] **Step 1: 写 .dockerignore**

```
node_modules
**/node_modules
data
.git
.claude
docs
apps/web/build
apps/web/.svelte-kit
**/*.test.ts
```

- [ ] **Step 2: 写 Dockerfile（多阶段）**

```dockerfile
# ---- build stage ----
FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lockb ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN bun install --frozen-lockfile
COPY apps apps
COPY packages packages
RUN bun --filter remote-reader-web build

# ---- runtime stage ----
FROM node:22-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends python3 make g++ \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json ./
COPY apps/web/package.json ./apps/web/
COPY packages/shared/package.json ./packages/shared/
RUN npm install --omit=dev
COPY --from=build /app/apps/web/build ./apps/web/build
ENV NODE_ENV=production
ENV PORT=3000
EXPOSE 3000
CMD ["node", "apps/web/build/index.js"]
```

> 注：runtime 用 `npm install --omit=dev` 让 better-sqlite3 / @node-rs/argon2 在 node:22 上编译或下载 prebuilt（python3/make/g++ 保底编译）。`@remote-reader/shared` 已 bundle 进 build，但 npm 会按 workspace 解析——无害。若 build 报 lockfile 缺失，去掉 `--frozen-lockfile`。

- [ ] **Step 3: 本地构建验证**

Run: `docker build -t remote-reader:test .`
Expected: 构建成功（关注 better-sqlite3 是否在 runtime 阶段装上）

- [ ] **Step 4: Commit**

```bash
git add Dockerfile .dockerignore
git commit -m "feat(sub3): multi-stage Dockerfile (bun build → node run)"
```

---

### Task 18: docker-compose + 端到端冒烟

**Files:**
- Create: `docker-compose.yml`

- [ ] **Step 1: 写 docker-compose.yml**

```yaml
services:
  web:
    build: .
    ports:
      - "3000:3000"
    volumes:
      - ./data:/app/data
    env_file:
      - .env
    environment:
      - NODE_ENV=production
      - DATABASE_PATH=/app/data/app.db
      - DATA_DIR=/app/data/documents
      - BASE_URL=http://localhost:3000
    restart: unless-stopped
```

> 部署时把 `BASE_URL` 改为对外域名，`.env` 至少含 `SESSION_SECRET`（长随机串）与 `INITIAL_INVITE_CODE`。

- [ ] **Step 2: 端到端冒烟**

```bash
# 确保 .env 有 SESSION_SECRET + INITIAL_INVITE_CODE
docker compose up --build -d
sleep 3
curl -sS -o /dev/null -w "%{http_code}\n" http://localhost:3000/   # 期望 200 或 302
# 浏览器：/register 注册首个 admin → 拿到/生成 API token → 用桥或 curl 上传 md → 打开 /s/<token> 看渲染 → 登出
docker compose down
```
Expected: 服务起来，主流程闭环；`./data` 持久化 db 与文档

- [ ] **Step 3: 全量回归**

Run: `bun run test && bun --filter remote-reader-web check && bun --filter remote-reader-mcp-bridge check`
Expected: 全部测试通过（74 → ~110），两端 0 类型错

- [ ] **Step 4: 回填主 spec + CLAUDE.md**

更新 `docs/superpowers/specs/2026-07-18-remote-reader-design.md` §15.1/§15.3（路由状态、子计划3 移除待做）与 §12 Phase 2 勾除；更新 `CLAUDE.md`「当前状态」。

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml docs/ CLAUDE.md
git commit -m "feat(sub3): docker-compose + e2e smoke + docs backfill"
```

---

## Self-Review（plan 自审）

**1. Spec 覆盖**（对照 spec §1.1 八项）：

| spec 范围 | 实现 Task |
|---|---|
| 文件管理器列表/删除/重命名/建文件夹 | Task 1,7,8,10 |
| 文件移动 | Task 2（moveNode）+ Task 9（UI） |
| 分享管理页 | Task 4（list/revoke）+ Task 14（UI） |
| token 管理页 | Task 5（模块）+ Task 12/13（UI） |
| logout | Task 6 |
| `/d/<id>` owner 查看页 | Task 1（getOwnedDocument）+ Task 11 |
| md 增强 Mermaid+KaTeX 懒加载 | Task 15（占位）+ Task 16（客户端） |
| Docker | Task 17/18 |

✅ 全覆盖。spec 附录 4 个开放编码点 → Task 2（moveNode 环路）、Task 3（deleteNode 级联）、Task 13（token 横幅 UX）、Task 16（mermaid 扫描+降级）。

**2. 占位扫描**：除标注 `【用户实现】`（learning 模式有意为之，均给测试+签名+约束）外，无 TBD/TODO/"add error handling" 等。✅

**3. 类型/签名一致性**：
- `moveNode(ownerId, id, newParentId): { ok, reason? }` — Task 2 定义，Task 9 action 调用一致 ✅
- `deleteNode(ownerId, id): void` — Task 3 定义，Task 10 action 调用一致 ✅
- `listSharesByOwner` 返回字段（token/documentName/createdAt）— Task 4 定义，Task 14 page 用 `s.documentName/s.token/s.createdAt` 一致 ✅
- `createTokenForUser → { id, plaintext }` — Task 5 定义，Task 12 action 用 `.plaintext` 一致 ✅
- `listTokens` 不返回 `tokenHash` — Task 5 select 不含 hash，Task 12 page 不读 hash ✅

**4. 已知实现期风险**（非占位，冒烟会暴露）：
- Docker runtime `npm install --omit=dev` 对 workspace + better-sqlite3 的解析——Task 18 冒烟验证，失败则切 node:22-bookworm-slim 或预编译策略。
- markdown-it math block rule 对复杂嵌套的边界——测试覆盖基本 case，足够。

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-19-sub3-management-ui-docker.md`. Two execution options:**

**1. Subagent-Driven（推荐）** — 每个 Task 派一个 fresh subagent，task 间两阶段 review，迭代快、上下文不爆。

**2. Inline Execution** — 在当前会话用 executing-plans 批量执行，带 checkpoint review。

**Which approach?**

> 注：标注 `【用户实现】` 的 Task（2、3、13、16）在执行到时会暂停请你写 5-10 行关键代码。

