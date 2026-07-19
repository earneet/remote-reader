import { test, expect, vi } from 'vitest';
import { checkRateLimit, sweepExpired } from '../src/lib/server/ratelimit';

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

test('窗口过期后计数重置（真累计→饱和→越界→重置）', () => {
    vi.useFakeTimers();
    try {
        const cfg = { max: 2, windowMs: 1000 };
        expect(checkRateLimit('rl-reset', cfg).allowed).toBe(true);
        expect(checkRateLimit('rl-reset', cfg).allowed).toBe(true);
        expect(checkRateLimit('rl-reset', cfg).allowed).toBe(false);
        vi.advanceTimersByTime(1001);
        const r = checkRateLimit('rl-reset', cfg);
        expect(r.allowed).toBe(true);
        expect(r.remaining).toBe(1);
    } finally {
        vi.useRealTimers();
    }
});

test('不同 key 互不影响', () => {
    const cfg = { max: 1, windowMs: 60_000 };
    expect(checkRateLimit('rl-d1', cfg).allowed).toBe(true);
    expect(checkRateLimit('rl-d2', cfg).allowed).toBe(true);
    expect(checkRateLimit('rl-d1', cfg).allowed).toBe(false);
});

test('sweepExpired 清理过期 bucket、保留未过期（防内存泄漏 M6）', () => {
    const t0 = Date.now();
    checkRateLimit('sweep-a', { max: 5, windowMs: 1000 });
    checkRateLimit('sweep-b', { max: 5, windowMs: 1000 });
    checkRateLimit('sweep-fresh', { max: 5, windowMs: 60_000 });
    expect(sweepExpired(t0)).toBe(0);
    const removed = sweepExpired(t0 + 2000);
    expect(removed).toBeGreaterThanOrEqual(2);
    expect(sweepExpired(t0 + 2000)).toBe(0);
});
