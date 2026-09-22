/** 数字点分版本比较（桥自检用，Layer ③）：缺段与非数字段按 0 计，返回 -1/0/1 */
export function compareVersions(a: string, b: string): number {
    const parse = (v: string): number[] =>
        v.split('.').map((seg) => (/^\d+$/.test(seg) ? Number(seg) : 0));
    const sa = parse(a);
    const sb = parse(b);
    const n = Math.max(sa.length, sb.length);
    for (let i = 0; i < n; i++) {
        const da = sa[i] ?? 0;
        const db = sb[i] ?? 0;
        if (da < db) return -1;
        if (da > db) return 1;
    }
    return 0;
}
