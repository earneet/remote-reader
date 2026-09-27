/** 行内大小显示（R-20）：原始字节数可读性差（`2097152 B`），与时间列 formatRelative 对齐 */
export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let v = n / 1024;
    let i = 0;
    while (v >= 1024 && i < units.length - 1) {
        v /= 1024;
        i++;
    }
    return `${v >= 100 ? Math.round(v) : Math.round(v * 10) / 10} ${units[i]}`;
}
