import { test, expect, afterEach } from 'vitest';
import { validateStartupConfig } from '../src/lib/server/startup-check';

const ORIG: NodeJS.ProcessEnv = { ...process.env };

afterEach(() => {
    for (const k of Object.keys(process.env)) {
        if (!(k in ORIG)) delete process.env[k];
    }
    Object.assign(process.env, ORIG);
});

function prod(env: Record<string, string | undefined>) {
    process.env.NODE_ENV = 'production';
    for (const [k, v] of Object.entries(env)) {
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
    prod({ SESSION_SECRET: 'a'.repeat(64), INITIAL_INVITE_CODE: 'goodcode123' });
    expect(() => validateStartupConfig()).not.toThrow();
});
