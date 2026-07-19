import { test, expect, afterEach } from 'vitest';
import { envInt, getBaseUrl, getSessionMaxAgeSeconds } from '../src/lib/server/env';

afterEach(() => {
    delete process.env.TEST_ENV_INT;
    delete process.env.BASE_URL;
    delete process.env.SESSION_MAX_AGE;
});

test('envInt undefined/空串 → 默认', () => {
    expect(envInt('TEST_ENV_INT', 42)).toBe(42);
    process.env.TEST_ENV_INT = '';
    expect(envInt('TEST_ENV_INT', 42)).toBe(42);
});

test('envInt 正常值', () => {
    process.env.TEST_ENV_INT = '100';
    expect(envInt('TEST_ENV_INT', 42)).toBe(100);
});

test('envInt 0 → 抛（fail-fast 防除零/无限 maxAge）', () => {
    process.env.TEST_ENV_INT = '0';
    expect(() => envInt('TEST_ENV_INT', 42)).toThrow();
});

test('envInt 负数 → 抛', () => {
    process.env.TEST_ENV_INT = '-5';
    expect(() => envInt('TEST_ENV_INT', 42)).toThrow();
});

test('envInt 非数字 → 抛', () => {
    process.env.TEST_ENV_INT = 'abc';
    expect(() => envInt('TEST_ENV_INT', 42)).toThrow();
});

test('envInt NaN/Infinity → 抛', () => {
    process.env.TEST_ENV_INT = 'NaN';
    expect(() => envInt('TEST_ENV_INT', 42)).toThrow();
    process.env.TEST_ENV_INT = 'Infinity';
    expect(() => envInt('TEST_ENV_INT', 42)).toThrow();
});

test('getBaseUrl 默认 + env 覆盖', () => {
    expect(getBaseUrl()).toBe('http://localhost:5173');
    process.env.BASE_URL = 'https://example.com';
    expect(getBaseUrl()).toBe('https://example.com');
});

test('getSessionMaxAgeSeconds 默认 30 天 + env 覆盖', () => {
    expect(getSessionMaxAgeSeconds()).toBe(2_592_000);
    process.env.SESSION_MAX_AGE = '3600';
    expect(getSessionMaxAgeSeconds()).toBe(3600);
});
