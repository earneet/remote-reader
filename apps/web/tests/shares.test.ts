import { test, expect } from 'vitest';
import { generateShareToken } from '../src/lib/server/shares';

test('生成非空 token', () => {
    expect(generateShareToken()).toBeTruthy();
});

test('两次生成不同', () => {
    expect(generateShareToken()).not.toBe(generateShareToken());
});

test('长度足够（≥20 字符，128bit 熵）', () => {
    expect(generateShareToken().length).toBeGreaterThanOrEqual(20);
});

test('字符集安全（base64url）', () => {
    const t = generateShareToken();
    expect(t).toMatch(/^[A-Za-z0-9_-]+$/);
});
