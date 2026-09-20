import { test, expect, beforeEach, afterEach } from 'vitest';
import { validateStartupConfig } from '../src/lib/server/startup-check';

const ORIG: NodeJS.ProcessEnv = { ...process.env };

beforeEach(() => {
    for (const k of ['OBJECT_STORE_ENDPOINT', 'OBJECT_STORE_REGION', 'OBJECT_STORE_BUCKET', 'OBJECT_STORE_ACCESS_KEY_ID', 'OBJECT_STORE_SECRET_ACCESS_KEY']) {
        delete process.env[k];
    }
});

afterEach(() => {
    for (const k of Object.keys(process.env)) {
        if (!(k in ORIG)) delete process.env[k];
    }
    Object.assign(process.env, ORIG);
});

function prod(env: Record<string, string | undefined>) {
    process.env.NODE_ENV = 'production';
    const merged = { ORIGIN: 'https://reader.example.com', ...env };
    for (const [k, v] of Object.entries(merged)) {
        if (v === undefined) delete process.env[k];
        else (process.env as Record<string, string>)[k] = v;
    }
}

test('dev/test 模式不校验', () => {
    process.env.NODE_ENV = 'development';
    expect(() => validateStartupConfig()).not.toThrow();
});

test('prod 缺 SESSION_SECRET 抛', () => {
    prod({ SESSION_SECRET: undefined, INITIAL_INVITE_CODE: 'goodcode123' });
    expect(() => validateStartupConfig()).toThrow(/SESSION_SECRET/);
});

test('prod 占位 SESSION_SECRET 抛', () => {
    prod({ SESSION_SECRET: 'change-me-to-a-long-random-string', INITIAL_INVITE_CODE: 'goodcode123' });
    expect(() => validateStartupConfig()).toThrow();
});

test('prod 短 SESSION_SECRET 抛', () => {
    prod({ SESSION_SECRET: 'short', INITIAL_INVITE_CODE: 'goodcode123' });
    expect(() => validateStartupConfig()).toThrow(/32/);
});

test('prod 占位 INITIAL_INVITE_CODE 抛', () => {
    prod({ SESSION_SECRET: 'a'.repeat(64), INITIAL_INVITE_CODE: 'change-me' });
    expect(() => validateStartupConfig()).toThrow(/INITIAL_INVITE_CODE/);
});

test('prod 缺 INITIAL_INVITE_CODE 抛', () => {
    prod({ SESSION_SECRET: 'a'.repeat(64), INITIAL_INVITE_CODE: undefined });
    expect(() => validateStartupConfig()).toThrow(/INITIAL_INVITE_CODE/);
});

test('prod 强配置通过', () => {
    prod({
        SESSION_SECRET: 'a'.repeat(64),
        INITIAL_INVITE_CODE: 'goodcode123',
        BASE_URL: 'https://reader.example.com',
        BODY_SIZE_LIMIT: '8M'
    });
    expect(() => validateStartupConfig()).not.toThrow();
});

test('prod 未设 ORIGIN → 抛（否则反代/直连下全部 form POST 被 CSRF 校验 403）', () => {
    prod({
        SESSION_SECRET: 'a'.repeat(64),
        INITIAL_INVITE_CODE: 'goodcode123',
        BASE_URL: 'https://reader.example.com',
        BODY_SIZE_LIMIT: '8M',
        ORIGIN: undefined
    });
    expect(() => validateStartupConfig()).toThrow(/ORIGIN/);
});

test('prod ORIGIN 与 BASE_URL 不同源 → 抛（占位值漂移防护）', () => {
    prod({
        SESSION_SECRET: 'a'.repeat(64),
        INITIAL_INVITE_CODE: 'goodcode123',
        BASE_URL: 'https://reader.example.com',
        BODY_SIZE_LIMIT: '8M',
        ORIGIN: 'https://your-host'
    });
    expect(() => validateStartupConfig()).toThrow(/ORIGIN/);
});

test('prod 未设 BODY_SIZE_LIMIT（adapter 默认 512K < MAX_UPLOAD_BYTES 默认 5M）→ 抛', () => {
    prod({
        SESSION_SECRET: 'a'.repeat(64),
        INITIAL_INVITE_CODE: 'goodcode123',
        BASE_URL: 'https://reader.example.com',
        BODY_SIZE_LIMIT: undefined,
        MAX_UPLOAD_BYTES: undefined
    });
    expect(() => validateStartupConfig()).toThrow(/BODY_SIZE_LIMIT/);
});

test('prod BODY_SIZE_LIMIT 不足 MAX_UPLOAD_BYTES×1.5 → 抛', () => {
    prod({
        SESSION_SECRET: 'a'.repeat(64),
        INITIAL_INVITE_CODE: 'goodcode123',
        BASE_URL: 'https://reader.example.com',
        BODY_SIZE_LIMIT: '1M',
        MAX_UPLOAD_BYTES: String(5 * 1024 * 1024)
    });
    expect(() => validateStartupConfig()).toThrow(/BODY_SIZE_LIMIT/);
});

test('prod BODY_SIZE_LIMIT 带单位后缀按 1024 进制解析（512K ≥ 1KB×1.5 通过）', () => {
    prod({
        SESSION_SECRET: 'a'.repeat(64),
        INITIAL_INVITE_CODE: 'goodcode123',
        BASE_URL: 'https://reader.example.com',
        BODY_SIZE_LIMIT: '512K',
        MAX_UPLOAD_BYTES: '1024'
    });
    expect(() => validateStartupConfig()).not.toThrow();
});

test('prod BODY_SIZE_LIMIT 非法值 → 抛', () => {
    prod({
        SESSION_SECRET: 'a'.repeat(64),
        INITIAL_INVITE_CODE: 'goodcode123',
        BASE_URL: 'https://reader.example.com',
        BODY_SIZE_LIMIT: '8X'
    });
    expect(() => validateStartupConfig()).toThrow(/BODY_SIZE_LIMIT/);
});

test('prod 缺 BASE_URL 抛', () => {
    prod({
        SESSION_SECRET: 'a'.repeat(64),
        INITIAL_INVITE_CODE: 'goodcode123',
        BASE_URL: undefined
    });
    expect(() => validateStartupConfig()).toThrow(/BASE_URL/);
});

test('prod localhost BASE_URL 抛', () => {
    prod({
        SESSION_SECRET: 'a'.repeat(64),
        INITIAL_INVITE_CODE: 'goodcode123',
        BASE_URL: 'http://localhost:5173'
    });
    expect(() => validateStartupConfig()).toThrow(/BASE_URL/);
});

test('prod 127.0.0.1 BASE_URL 抛', () => {
    prod({
        SESSION_SECRET: 'a'.repeat(64),
        INITIAL_INVITE_CODE: 'goodcode123',
        BASE_URL: 'http://127.0.0.1:3000'
    });
    expect(() => validateStartupConfig()).toThrow(/BASE_URL/);
});

test('OBJECT_STORE_* 部分配置 → dev 也 fail-fast（确定性配置错误）', () => {
    process.env.NODE_ENV = 'development';
    process.env.OBJECT_STORE_BUCKET = 'b';
    expect(() => validateStartupConfig()).toThrow(/OBJECT_STORE|不完整/);
});

test('OBJECT_STORE_* 完整配置 → 不抛', () => {
    process.env.NODE_ENV = 'development';
    Object.assign(process.env, {
        OBJECT_STORE_ENDPOINT: 'https://s3.cn-east-1.qiniucs.com',
        OBJECT_STORE_REGION: 'cn-east-1',
        OBJECT_STORE_BUCKET: 'b',
        OBJECT_STORE_ACCESS_KEY_ID: 'ak',
        OBJECT_STORE_SECRET_ACCESS_KEY: 'sk'
    });
    expect(() => validateStartupConfig()).not.toThrow();
});
