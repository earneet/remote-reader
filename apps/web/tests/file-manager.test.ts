import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';

import { resetDb } from './helpers';
const mod = await import('../src/routes/+page.server');

const TMP = `./data/test-fm-${Date.now().toString(36)}`;

beforeEach(() => {
    process.env.DATA_DIR = TMP;
    resetDb();
});

afterEach(() => {
    try {
        rmSync(TMP, { recursive: true, force: true });
    } catch {}
});

function insertUser(id: string): void {
    db.insert(schema.users).values({
        id, email: `t-${id}@x.com`, passwordHash: 'x', role: 'member', createdAt: Date.now()
    }).run();
}

function formRequest(form: Record<string, string>): Request {
    const fd = new FormData();
    for (const [k, v] of Object.entries(form)) fd.append(k, v);
    return new Request('http://localhost/x', { method: 'POST', body: fd });
}

async function invoke(
    fn: (evt: any) => unknown,
    userId: string | null,
    form: Record<string, string>,
    url: URL = new URL('http://localhost/')
): Promise<unknown> {
    return fn({
        locals: userId ? { user: { id: userId } } : { user: null },
        request: formRequest(form),
        url
    });
}


// fail() 返回 ActionFailure（带 .status 不抛出）——断言其状态码
async function expectStatus(
    fn: (evt: any) => unknown,
    userId: string,
    form: Record<string, string>,
    status: number
): Promise<void> {
    const r = await invoke(fn, userId, form);
    expect((r as { status?: number })?.status).toBe(status);
}

// ===== createFolder =====

test('createFolder：正常创建文件夹', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await invoke(mod.actions.createFolder, ownerId, { name: 'reports' });
    const folders = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.type, 'folder'))).all();
    expect(folders.length).toBe(1);
    expect(folders[0].name).toBe('reports');
});

test('createFolder：URL 带 dir 参数 → 建到指定子目录而非根（F1 回归）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await uploadDocument(ownerId, 'seed.md', 'x', ['parent']);
    const parent = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.name, 'parent'), eq(schema.documents.type, 'folder'))).get()!;
    // 前端表单 action="?dir=<id>&/createFolder"——WHATWG 相对解析保留 dir
    await invoke(mod.actions.createFolder, ownerId, { name: 'child' },
        new URL(`http://localhost/?dir=${parent.id}&/createFolder`));
    const child = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.name, 'child'))).get();
    expect(child?.parentId).toBe(parent.id);
});

test('createFolder：空 name → 400', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await expectStatus(mod.actions.createFolder, ownerId, { name: '' }, 400);
});

test('createFolder：name 含路径分隔符 → 400（sanitizeSingleName）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await expectStatus(mod.actions.createFolder, ownerId, { name: 'a/b' }, 400);
});

test('createFolder：文件夹重名 → 409（不再静默成功）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await invoke(mod.actions.createFolder, ownerId, { name: 'dup' });
    await expectStatus(mod.actions.createFolder, ownerId, { name: 'dup' }, 409);
    const folders = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.name, 'dup'), eq(schema.documents.type, 'folder'))).all();
    expect(folders.length).toBe(1);
});

test('createFolder：与同名 file 冲突 → 409（防陷阱目录，P1-4）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await uploadDocument(ownerId, 'q2.md', 'x', []);
    await expectStatus(mod.actions.createFolder, ownerId, { name: 'q2.md' }, 409);
    const folders = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.type, 'folder'))).all();
    expect(folders.length).toBe(0);
});

test('rename：改成与 folder 同名 → 409（跨类型互斥，P1-4）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await invoke(mod.actions.createFolder, ownerId, { name: 'target' });
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    await expectStatus(mod.actions.rename, ownerId, { id: r.id, name: 'target' }, 409);
});

// ===== rename =====

test('rename：正常重命名', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const r = await uploadDocument(ownerId, 'old.md', 'x', []);
    await invoke(mod.actions.rename, ownerId, { id: r.id, name: 'new.md' });
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()?.name).toBe('new.md');
});

test('rename：空 id/name → 400', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await expectStatus(mod.actions.rename, ownerId, { id: '', name: 'x.md' }, 400);
});

test('rename：name 含分隔符 → 400', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    await expectStatus(mod.actions.rename, ownerId, { id: r.id, name: 'b/c' }, 400);
});

test('rename：节点不存在 → 404', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await expectStatus(mod.actions.rename, ownerId, { id: 'nonexistent', name: 'x.md' }, 404);
});

test('rename：同父同名冲突 → 409', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    await expectStatus(mod.actions.rename, ownerId, { id: b.id, name: 'a.md' }, 409);
});

// ===== move / delete =====

test('move：空 id → 400', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await expectStatus(mod.actions.move, ownerId, { id: '', target: 'root' }, 400);
});

test('delete：空 id → 400', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await expectStatus(mod.actions.delete, ownerId, { id: '' }, 400);
});

test('delete：正常删除文档', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const r = await uploadDocument(ownerId, 'del.md', 'x', []);
    await invoke(mod.actions.delete, ownerId, { id: r.id });
    expect(db.select().from(schema.documents).where(eq(schema.documents.id, r.id)).get()).toBeUndefined();
});

// ===== 未登录 =====

test('未登录 createFolder → redirect 302', async () => {
    await expect(invoke(mod.actions.createFolder, null, { name: 'x' })).rejects.toMatchObject({ status: 302 });
});

// ===== setTags =====

test('setTags：正常设置标签', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    await invoke(mod.actions.setTags, ownerId, { id: r.id, tags: '周报, api' });
    const data = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/') } as any);
    expect((data as any).tagsByDoc.get(r.id).map((t: any) => t.name).sort()).toEqual(['api', '周报']);
});

test('setTags：非法标签名 → 400', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    await expectStatus(mod.actions.setTags, ownerId, { id: r.id, tags: 'a/b' }, 400);
});

test('setTags：非 owner 文档 → 404', async () => {
    const ownerId = generateId();
    const other = generateId();
    insertUser(ownerId); insertUser(other);
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    await expectStatus(mod.actions.setTags, other, { id: r.id, tags: 'x' }, 404);
});

// ===== load 视图分支（recent，spec §6.1） =====

function setUpdatedAt(id: string, ts: number): void {
    db.update(schema.documents).set({ updatedAt: ts }).where(eq(schema.documents.id, id)).run();
}

test('load：view=recent 返回全局 recent 且 children 空', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const a = await uploadDocument(ownerId, 'a.md', 'x', ['d1']);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setUpdatedAt(a.id, T);
    setUpdatedAt(b.id, T + 1);
    const data = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/?view=recent') } as any);
    expect((data as any).view).toBe('recent');
    expect((data as any).children).toEqual([]);
    expect((data as any).recent.map((r: any) => r.name)).toEqual(['b.md', 'a.md']);
});

test('load：view=recent 内嵌 tags', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    await invoke(mod.actions.setTags, ownerId, { id: a.id, tags: '周报' });
    const data = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/?view=recent') } as any);
    const item = (data as any).recent.find((r: any) => r.id === a.id);
    expect(item.tags.map((t: any) => t.name)).toEqual(['周报']);
});

test('load：缺省 view=dir，行为不变（children 正常、recent 空）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await uploadDocument(ownerId, 'a.md', 'x', []);
    const data = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/') } as any);
    expect((data as any).view).toBe('dir');
    expect((data as any).children.length).toBe(1);
    expect((data as any).recent).toEqual([]);
});

test('load：view=recent 时 dir 参数被忽略（recent 优先级锁定）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const a = await uploadDocument(ownerId, 'a.md', 'x', ['d1']);
    const data = await mod.load({ locals: { user: { id: ownerId } }, url: new URL(`http://localhost/?view=recent&dir=${a.id}`) } as any);
    expect((data as any).view).toBe('recent');
    expect((data as any).currentDir).toBe(null);
    expect((data as any).recent.length).toBe(1);
});

// ===== load 视图分支（viewed，「最近浏览」spec §7.2） =====

function setOwnerViewedAt(id: string, ts: number | null): void {
    db.update(schema.documents).set({ ownerViewedAt: ts }).where(eq(schema.documents.id, id)).run();
}

test('load：view=viewed 返回按浏览序的 viewed 且 children/recent 空', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    const T = 1_700_000_000_000;
    setOwnerViewedAt(a.id, T);
    setOwnerViewedAt(b.id, T + 1);
    const data = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/?view=viewed') } as any);
    expect((data as any).view).toBe('viewed');
    expect((data as any).children).toEqual([]);
    expect((data as any).viewed.map((r: any) => r.name)).toEqual(['b.md', 'a.md']);
    expect((data as any).recent).toEqual([]);
});

test('load：view=viewed 未浏览不出现；dir/recent 分支 viewed 为空', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await uploadDocument(ownerId, 'a.md', 'x', []);
    const viewedData = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/?view=viewed') } as any);
    expect((viewedData as any).viewed).toEqual([]);
    const dirData = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/') } as any);
    expect((dirData as any).viewed).toEqual([]);
});

test('load：view 非法值回落 dir（既有模式扩展）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const data = await mod.load({ locals: { user: { id: ownerId } }, url: new URL('http://localhost/?view=bogus') } as any);
    expect((data as any).view).toBe('dir');
});
