const buckets = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitConfig {
    max: number;
    windowMs: number;
}

const SWEEP_INTERVAL_MS = 60_000;
let lastSweep = Date.now();

// 清理所有已过期 bucket，返回清理数量。防长期运行的 buckets Map 无界增长（M6，合并 #19/#32/#45）。
export function sweepExpired(now: number): number {
    let removed = 0;
    for (const [k, b] of buckets) {
        if (b.resetAt <= now) {
            buckets.delete(k);
            removed++;
        }
    }
    return removed;
}

export function checkRateLimit(
    key: string,
    cfg: RateLimitConfig
): { allowed: boolean; remaining: number } {
    const now = Date.now();
    // 周期性清理过期 bucket，避免不再访问的 key 永久占内存
    if (now - lastSweep > SWEEP_INTERVAL_MS) {
        sweepExpired(now);
        lastSweep = now;
    }
    const b = buckets.get(key);
    if (!b || b.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + cfg.windowMs });
        return { allowed: true, remaining: cfg.max - 1 };
    }
    if (b.count >= cfg.max) return { allowed: false, remaining: 0 };
    b.count++;
    return { allowed: true, remaining: cfg.max - b.count };
}
