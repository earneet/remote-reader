export function envInt(key: string, def: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`env ${key} 必须是正整数，实际值: ${JSON.stringify(raw)}`);
    }
    return n;
}

export function getBaseUrl(): string {
    // 尾斜杠归一化：拼接 `${getBaseUrl()}/s/${token}` 时防产生 `//s/<token>` 双斜杠链接（实测 404）
    return (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
}

export function getSessionMaxAgeSeconds(): number {
    return envInt('SESSION_MAX_AGE', 2_592_000);
}

export function getColdTierAfterDays(): number {
    return envInt('COLD_TIER_AFTER_DAYS', 30);
}
