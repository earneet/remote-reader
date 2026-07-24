import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';

const tokensMod = await import('../src/routes/settings/tokens/+page.server');
const sharesMod = await import('../src/routes/settings/shares/+page.server');

const TMP = `./data/test-settings-${Date.now().toString(36)}`;

beforeEach(() => {
    process.env.DATA_DIR = TMP;
    db.delete(schema.shareLinks).run();
    db.delete(schema.documents).run();
    db.delete(schema.apiTokens).run();
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

// ===== settings/tokens =====

test('tokens load 返回 owner 的 token 列表（不含 tokenHash）', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await tokensMod.actions.create({
        locals: { user: { id: ownerId } }, request: formRequest({ name: 'my token' })
    } as never);
    const result = (await tokensMod.load({ locals: { user: { id: ownerId } } } as never)) as { tokens: unknown[] };
    expect(result.tokens.length).toBe(1);
    expect(JSON.stringify(result.tokens)).not.toContain('tokenHash');
});

test('tokens create 返回明文 plaintext（rr_ 前缀）且 DB 新增一行', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    const r = (await tokensMod.actions.create({
        locals: { user: { id: ownerId } }, request: formRequest({ name: 'new' })
    } as never)) as { plaintext: string };
    expect(r.plaintext).toMatch(/^rr_/);
    expect(db.select().from(schema.apiTokens).all().length).toBe(1);
});

test('tokens create 空 name → 400', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await expect(tokensMod.actions.create({
        locals: { user: { id: ownerId } }, request: formRequest({ name: '' })
    } as never)).rejects.toMatchObject({ status: 400 });
});

test('tokens revoke 删除自己的 token', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await tokensMod.actions.create({
        locals: { user: { id: ownerId } }, request: formRequest({ name: 'x' })
    } as never);
    const token = db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, ownerId)).all()[0];
    await tokensMod.actions.revoke({
        locals: { user: { id: ownerId } }, request: formRequest({ id: token.id })
    } as never);
    expect(db.select().from(schema.apiTokens).all().length).toBe(0);
});

test('tokens revoke 非 owner 的 token 不生效（不删别人 token）', async () => {
    const a = generateId();
    const b = generateId();
    insertUser(a);
    insertUser(b);
    await tokensMod.actions.create({
        locals: { user: { id: a } }, request: formRequest({ name: 'a-token' })
    } as never);
    const token = db.select().from(schema.apiTokens).where(eq(schema.apiTokens.userId, a)).all()[0];
    await tokensMod.actions.revoke({
        locals: { user: { id: b } }, request: formRequest({ id: token.id })
    } as never);
    expect(db.select().from(schema.apiTokens).all().length).toBe(1);
});

test('tokens 未登录 load → redirect 302', async () => {
    await expect(tokensMod.load({ locals: { user: null } } as never)).rejects.toMatchObject({ status: 302 });
});

// ===== settings/shares =====

test('shares load 返回 owner 的 share 列表', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await uploadDocument(ownerId, 'a.md', '# hi', []);
    const result = (await sharesMod.load({ locals: { user: { id: ownerId } } } as never)) as { shares: unknown[] };
    expect(result.shares.length).toBe(1);
});

test('shares revoke 删除 share token', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await uploadDocument(ownerId, 'a.md', 'x', []);
    const share = db.select().from(schema.shareLinks).all()[0];
    await sharesMod.actions.revoke({
        locals: { user: { id: ownerId } }, request: formRequest({ token: share.token })
    } as never);
    expect(db.select().from(schema.shareLinks).all().length).toBe(0);
});

test('shares revoke 空 token → 400', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await expect(sharesMod.actions.revoke({
        locals: { user: { id: ownerId } }, request: formRequest({ token: '' })
    } as never)).rejects.toMatchObject({ status: 400 });
});

test('shares 未登录 load → redirect 302', async () => {
    await expect(sharesMod.load({ locals: { user: null } } as never)).rejects.toMatchObject({ status: 302 });
});
