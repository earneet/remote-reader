import { test, expect, afterEach, describe, it } from 'vitest';
import { envInt, getBaseUrl, getBridgeRepoUrl, getImageProxyAll, getImageSignedUrlTtl, getImageStoreBackend, getMaxImageBytes, getSessionMaxAgeSeconds } from '../src/lib/server/env';

afterEach(() => {
    delete process.env.TEST_ENV_INT;
    delete process.env.BASE_URL;
    delete process.env.SESSION_MAX_AGE;
    delete process.env.BRIDGE_REPO_URL;
    delete process.env.IMAGE_STORE_BACKEND;
    delete process.env.MAX_IMAGE_BYTES;
    delete process.env.IMAGE_SIGNED_URL_TTL;
    delete process.env.IMAGE_PROXY_ALL;
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

test('getBaseUrl 尾斜杠归一化（防 //s/<token> 双斜杠 404）', () => {
    process.env.BASE_URL = 'https://example.com/';
    expect(getBaseUrl()).toBe('https://example.com');
    process.env.BASE_URL = 'https://example.com//';
    expect(getBaseUrl()).toBe('https://example.com');
});

test('getSessionMaxAgeSeconds 默认 30 天 + env 覆盖', () => {
    expect(getSessionMaxAgeSeconds()).toBe(2_592_000);
    process.env.SESSION_MAX_AGE = '3600';
    expect(getSessionMaxAgeSeconds()).toBe(3600);
});

test('getBridgeRepoUrl：默认值 / env 覆盖 / 尾斜杠归一化', () => {
    expect(getBridgeRepoUrl()).toBe('https://github.com/earneet/remote-reader');
    process.env.BRIDGE_REPO_URL = 'https://git.example.com/foo/bar/';
    expect(getBridgeRepoUrl()).toBe('https://git.example.com/foo/bar');
});

describe('getImageStoreBackend / getMaxImageBytes', () => {
    it('默认 local / 10MB', () => {
        delete process.env.IMAGE_STORE_BACKEND;
        delete process.env.MAX_IMAGE_BYTES;
        expect(getImageStoreBackend()).toBe('local');
        expect(getMaxImageBytes()).toBe(10 * 1024 * 1024);
    });
    it('合法值 s3 / 自定义字节', () => {
        process.env.IMAGE_STORE_BACKEND = 's3';
        process.env.MAX_IMAGE_BYTES = '2097152';
        expect(getImageStoreBackend()).toBe('s3');
        expect(getMaxImageBytes()).toBe(2097152);
        delete process.env.IMAGE_STORE_BACKEND;
        delete process.env.MAX_IMAGE_BYTES;
    });
    it('非法后端值 fail-fast', () => {
        process.env.IMAGE_STORE_BACKEND = 'ftp';
        expect(() => getImageStoreBackend()).toThrow('IMAGE_STORE_BACKEND');
        delete process.env.IMAGE_STORE_BACKEND;
    });
});

describe('getImageSignedUrlTtl / getImageProxyAll', () => {
    it('默认 3600 / 关闭', () => {
        delete process.env.IMAGE_SIGNED_URL_TTL;
        delete process.env.IMAGE_PROXY_ALL;
        expect(getImageSignedUrlTtl()).toBe(3600);
        expect(getImageProxyAll()).toBe(false);
    });
    it('自定义值 / 开启', () => {
        process.env.IMAGE_SIGNED_URL_TTL = '7200';
        process.env.IMAGE_PROXY_ALL = '1';
        expect(getImageSignedUrlTtl()).toBe(7200);
        expect(getImageProxyAll()).toBe(true);
        delete process.env.IMAGE_SIGNED_URL_TTL;
        delete process.env.IMAGE_PROXY_ALL;
    });
    it('非法值 fail-fast', () => {
        process.env.IMAGE_SIGNED_URL_TTL = '0';
        expect(() => getImageSignedUrlTtl()).toThrow();
        process.env.IMAGE_SIGNED_URL_TTL = 'abc';
        expect(() => getImageSignedUrlTtl()).toThrow();
        process.env.IMAGE_PROXY_ALL = 'yes';
        expect(() => getImageProxyAll()).toThrow(/IMAGE_PROXY_ALL/);
        delete process.env.IMAGE_SIGNED_URL_TTL;
        delete process.env.IMAGE_PROXY_ALL;
    });
});
