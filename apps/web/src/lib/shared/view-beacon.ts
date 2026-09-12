// 「最近浏览」上报（spec §7.1）：查看页 onMount 调用；fire-and-forget，失败静默——
// 阅读顺序是便利功能，丢一次上报可接受；keepalive 提高关页前送达率
export function reportView(docId: string): void {
    void fetch(`/api/view/${encodeURIComponent(docId)}`, { method: 'POST', keepalive: true }).catch(() => {});
}
