import type { RequestHandler } from './$types';

// H6: 接收浏览器 CSP 违规报告（report-only 模式必需配套）。
// 当前实现：dev/test 打印到 stderr 便于排查；prod 静默返回 204，避免日志刷屏。
// 后续如需分析，可改为写 SQLite 或转发到日志服务（注意采样与体积上限）。
export const POST: RequestHandler = async ({ request }) => {
    if (process.env.NODE_ENV !== 'production') {
        const body = await request.json().catch(() => null);
        if (body) console.warn('[csp-report]', JSON.stringify(body));
    }
    return new Response(null, { status: 204 });
};
