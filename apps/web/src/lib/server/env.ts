export function envInt(key: string, def: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`env ${key} 必须是正整数，实际值: ${JSON.stringify(raw)}`);
    }
    return n;
}
