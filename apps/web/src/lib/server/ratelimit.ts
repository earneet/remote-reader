const buckets = new Map<string, { count: number; resetAt: number }>();

export interface RateLimitConfig {
    max: number;
    windowMs: number;
}

export function checkRateLimit(
    key: string,
    cfg: RateLimitConfig
): { allowed: boolean; remaining: number } {
    const now = Date.now();
    const b = buckets.get(key);
    if (!b || b.resetAt <= now) {
        buckets.set(key, { count: 1, resetAt: now + cfg.windowMs });
        return { allowed: true, remaining: cfg.max - 1 };
    }
    if (b.count >= cfg.max) return { allowed: false, remaining: 0 };
    b.count++;
    return { allowed: true, remaining: cfg.max - b.count };
}
