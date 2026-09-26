import { test, expect, beforeEach, afterEach } from 'vitest';
import { rmSync } from 'node:fs';
import { eq } from 'drizzle-orm';
import { db, schema } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';

import { resetDb } from './helpers';
const tokensMod = await import('../src/routes/settings/tokens/+page.server');
const sharesMod = await import('../src/routes/settings/shares/+page.server');
const invitesMod = await import('../src/routes/settings/invites/+page.server');

const TMP = `./data/test-settings-${Date.now().toString(36)}`;

beforeEach(() => {
    process.env.DATA_DIR = TMP;
    resetDb();
});

afterEach(() => {
    try {
        rmSync(TMP, { recursive: true, force: true });
    } catch {}
});

function insertUser(id: string, role: 'admin' | 'member' = 'member'): void {
    db.insert(schema.users).values({
        id, email: `t-${id}@x.com`, passwordHash: 'x', role, createdAt: Date.now()
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
    } as never)).resolves.toMatchObject({ status: 400 });
});

test('tokens create name 超长（>100 字符）→ 400', async () => {
    const ownerId = generateId();
    insertUser(ownerId);
    await expect(tokensMod.actions.create({
        locals: { user: { id: ownerId } }, request: formRequest({ name: 'x'.repeat(101) })
    } as never)).resolves.toMatchObject({ status: 400 });
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
    } as never)).resolves.toMatchObject({ status: 400 });
});

test('shares 未登录 load → redirect 302', async () => {
    await expect(sharesMod.load({ locals: { user: null } } as never)).rejects.toMatchObject({ status: 302 });
});

// ===== settings/invites =====

test('invites 未登录 load → redirect 302', async () => {
    await expect(invitesMod.load({ locals: { user: null } } as never)).rejects.toMatchObject({ status: 302 });
});

test('invites member load → 403', async () => {
    const uid = generateId();
    insertUser(uid);
    await expect(invitesMod.load({ locals: { user: { id: uid, role: 'member' } } } as never))
        .rejects.toMatchObject({ status: 403 });
});

test('invites admin create 返回 ri_ 明文且 load 列表不含 codeHash', async () => {
    const adminId = generateId();
    insertUser(adminId, 'admin');
    const r = (await invitesMod.actions.create({
        locals: { user: { id: adminId, role: 'admin' } }, request: formRequest({ note: 'new', days: '7' })
    } as never)) as { plaintext: string };
    expect(r.plaintext).toMatch(/^ri_/);
    const result = (await invitesMod.load({ locals: { user: { id: adminId, role: 'admin' } } } as never)) as { invites: unknown[] };
    expect(result.invites.length).toBe(1);
    expect(JSON.stringify(result)).not.toContain('codeHash');
});

test('invites create 空 note → 400', async () => {
    const adminId = generateId();
    insertUser(adminId, 'admin');
    await expect(invitesMod.actions.create({
        locals: { user: { id: adminId, role: 'admin' } }, request: formRequest({ note: '', days: '7' })
    } as never)).resolves.toMatchObject({ status: 400 });
});

test('invites create 非法 days → 400', async () => {
    const adminId = generateId();
    insertUser(adminId, 'admin');
    await expect(invitesMod.actions.create({
        locals: { user: { id: adminId, role: 'admin' } }, request: formRequest({ note: 'x', days: '5' })
    } as never)).resolves.toMatchObject({ status: 400 });
});

test('invites member create → 403', async () => {
    const uid = generateId();
    insertUser(uid);
    await expect(invitesMod.actions.create({
        locals: { user: { id: uid, role: 'member' } }, request: formRequest({ note: 'x', days: '7' })
    } as never)).rejects.toMatchObject({ status: 403 });
});

test('invites revoke 置 revokedAt', async () => {
    const adminId = generateId();
    insertUser(adminId, 'admin');
    await invitesMod.actions.create({
        locals: { user: { id: adminId, role: 'admin' } }, request: formRequest({ note: 'x', days: '7' })
    } as never);
    const row = db.select().from(schema.inviteCodes).all()[0];
    await invitesMod.actions.revoke({
        locals: { user: { id: adminId, role: 'admin' } }, request: formRequest({ id: row.id })
    } as never);
    expect(db.select().from(schema.inviteCodes).all()[0].revokedAt).not.toBeNull();
});
