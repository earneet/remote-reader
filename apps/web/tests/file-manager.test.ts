import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { and, eq } from 'drizzle-orm';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';

const mod = await import('../src/routes/+page.server');

const TMP = `./data/test-fm-${Date.now().toString(36)}`;

beforeEach(() => {
    process.env.DATA_DIR = TMP;
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
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
    form: Record<string, string>
): Promise<unknown> {
    return fn({
        locals: userId ? { user: { id: userId } } : { user: null },
        request: formRequest(form),
        url: new URL('http://localhost/')
    });
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

test('createFolder：空 name → 400', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await expect(invoke(mod.actions.createFolder, ownerId, { name: '' })).rejects.toMatchObject({ status: 400 });
});

test('createFolder：name 含路径分隔符 → 400（sanitizeSingleName）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await expect(invoke(mod.actions.createFolder, ownerId, { name: 'a/b' })).rejects.toMatchObject({ status: 400 });
});

test('createFolder：重名不重复建', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await invoke(mod.actions.createFolder, ownerId, { name: 'dup' });
    await invoke(mod.actions.createFolder, ownerId, { name: 'dup' });
    const folders = db.select().from(schema.documents)
        .where(and(eq(schema.documents.ownerId, ownerId), eq(schema.documents.name, 'dup'), eq(schema.documents.type, 'folder'))).all();
    expect(folders.length).toBe(1);
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
    await expect(invoke(mod.actions.rename, ownerId, { id: '', name: 'x.md' })).rejects.toMatchObject({ status: 400 });
});

test('rename：name 含分隔符 → 400', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    await expect(invoke(mod.actions.rename, ownerId, { id: r.id, name: 'b/c' })).rejects.toMatchObject({ status: 400 });
});

test('rename：节点不存在 → 404', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await expect(invoke(mod.actions.rename, ownerId, { id: 'nonexistent', name: 'x.md' })).rejects.toMatchObject({ status: 404 });
});

test('rename：同父同名冲突 → 409', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    await expect(invoke(mod.actions.rename, ownerId, { id: b.id, name: 'a.md' })).rejects.toMatchObject({ status: 409 });
});

// ===== move / delete =====

test('move：空 id → 400', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await expect(invoke(mod.actions.move, ownerId, { id: '', target: 'root' })).rejects.toMatchObject({ status: 400 });
});

test('delete：空 id → 400', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await expect(invoke(mod.actions.delete, ownerId, { id: '' })).rejects.toMatchObject({ status: 400 });
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
    await expect(invoke(mod.actions.setTags, ownerId, { id: r.id, tags: 'a/b' })).rejects.toMatchObject({ status: 400 });
});

test('setTags：非 owner 文档 → 404', async () => {
    const ownerId = generateId();
    const other = generateId();
    insertUser(ownerId); insertUser(other);
    const r = await uploadDocument(ownerId, 'a.md', 'x', []);
    await expect(invoke(mod.actions.setTags, other, { id: r.id, tags: 'x' })).rejects.toMatchObject({ status: 404 });
});
