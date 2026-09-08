// 相对时间（spec §6.4）：分钟级粒度，直接 SSR 渲染——SSR→hydrate 时间差造成的
// 文本不一致概率可忽略且无害。now 参数仅为测试可确定性注入。
export function formatRelative(ts: number, now: number = Date.now()): string {
    const diff = now - ts;
    if (diff < 60_000) return '刚刚';
    if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
    if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
    if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
    const d = new Date(ts);
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${d.getFullYear()}-${m}-${day}`;
}
