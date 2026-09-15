// SvelteKit form action 的 fetch 直调（目录视图移动/删除与 RecentList 各操作共用）。
// 注意：JS fetch 下 action 的 fail() 以 HTTP 200 + {"type":"failure","status":409} 信封返回
// （HTTP 状态码只反映传输层），必须解信封拿真实状态码——失败文案按状态映射
export async function submitAction(action: string, fields: Record<string, string>): Promise<number> {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.append(k, v);
    const r = await fetch(`?/${action}`, { method: 'POST', body: fd });
    if ((r.headers.get('content-type') ?? '').includes('application/json')) {
        const body = await r.json().catch(() => null) as { type?: string; status?: number } | null;
        if (body?.type === 'failure') return typeof body.status === 'number' ? body.status : 500;
        if (body?.type === 'success' || body?.type === 'redirect') return 200;
    }
    return r.status;
}

export function actionErrorMessage(status: number): string {
    if (status === 409) return '同名节点已存在';
    if (status === 400) return '名称非法';
    if (status === 404) return '文档不存在（可能已被删除）';
    return '操作失败，请重试';
}
