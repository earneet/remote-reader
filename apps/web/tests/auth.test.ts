import { test, expect } from 'vitest';
import {
    hashPassword,
    verifyPassword,
    generateId,
    sha256Hex,
    generateApiToken,
    hashToken
} from '../src/lib/server/auth';

test('hashPassword 后 verifyPassword 能校验正确密码', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('correct horse battery staple', hash)).toBe(true);
});

test('错误密码校验失败', async () => {
    const hash = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('wrong', hash)).toBe(false);
});

test('两次哈希不同（含盐）', async () => {
    const a = await hashPassword('same');
    const b = await hashPassword('same');
    expect(a).not.toBe(b);
});

test('generateId 唯一且长度合理', () => {
    const a = generateId();
    const b = generateId();
    expect(a).not.toBe(b);
    expect(a.length).toBeGreaterThanOrEqual(20);
});

test('sha256Hex 确定性且区分输入', () => {
    expect(sha256Hex('abc')).toBe(sha256Hex('abc'));
    expect(sha256Hex('abc')).not.toBe(sha256Hex('abd'));
});

test('generateApiToken 返回明文与哈希不同', async () => {
    const { plaintext, hash } = await generateApiToken();
    expect(plaintext).toBeTruthy();
    expect(hash).not.toBe(plaintext);
    expect(hashToken(plaintext)).toBe(hash);
});

test('hashToken 确定性（同明文同哈希）', async () => {
    const { plaintext } = await generateApiToken();
    expect(hashToken(plaintext)).toBe(hashToken(plaintext));
});
