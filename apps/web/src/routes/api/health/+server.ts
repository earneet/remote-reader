import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { sqlite } from '$server/db';

// M15: healthcheck 命中此端点（含 DB SELECT 1），DB 不可用时返回 503，
// 使容器健康状态真实反映数据层而非仅进程存活。
export const GET: RequestHandler = async () => {
    try {
        sqlite.prepare('SELECT 1').get();
        return json({ ok: true });
    } catch {
        return json({ ok: false }, { status: 503 });
    }
};
