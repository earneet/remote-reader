import { test, expect } from 'vitest';
import { checkRateLimit } from '../src/lib/server/ratelimit';

test('首次请求 allowed，remaining = max - 1', () => {
    const r = checkRateLimit('rl-a', { max: 3, windowMs: 60_000 });
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(2);
});

test('窗口内计数递减，达上限后拒绝', () => {
    const cfg = { max: 2, windowMs: 60_000 };
    expect(checkRateLimit('rl-b', cfg).allowed).toBe(true);
    expect(checkRateLimit('rl-b', cfg).allowed).toBe(true);
    const r = checkRateLimit('rl-b', cfg);
    expect(r.allowed).toBe(false);
    expect(r.remaining).toBe(0);
});

test('窗口过期后计数重置', () => {
    const cfg = { max: 1, windowMs: 0 };
    expect(checkRateLimit('rl-c', cfg).allowed).toBe(true);
    const r = checkRateLimit('rl-c', cfg);
    expect(r.allowed).toBe(true);
    expect(r.remaining).toBe(0);
});

test('不同 key 互不影响', () => {
    const cfg = { max: 1, windowMs: 60_000 };
    expect(checkRateLimit('rl-d1', cfg).allowed).toBe(true);
    expect(checkRateLimit('rl-d2', cfg).allowed).toBe(true);
    expect(checkRateLimit('rl-d1', cfg).allowed).toBe(false);
});
