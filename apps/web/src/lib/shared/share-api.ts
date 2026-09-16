// FM 分享动作的 fetch 薄客户端（spec 2026-09-16 §4）：API 交互与状态语义单源
// （DELETE 404 = 文档已不在，视为完成）；confirm/错误横幅/刷新编排留在各视图
// （两视图错误通道与刷新机制本就不同——目录视图 invalidateAll、RecentList 再加 reSync）
export async function fetchShareUrl(id: string): Promise<string | null> {
    const r = await fetch(`/api/share/${encodeURIComponent(id)}`, { method: 'POST' });
    if (!r.ok) return null;
    return (await r.json() as { url: string }).url;
}

export async function revokeDocShares(id: string): Promise<boolean> {
    const r = await fetch(`/api/share/${encodeURIComponent(id)}`, { method: 'DELETE' });
    return r.ok || r.status === 404;
}
