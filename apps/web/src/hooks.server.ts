import type { Handle } from '@sveltejs/kit';
import { db, schema } from '$server/db';
import { readSession } from '$server/session';
import { validateStartupConfig } from '$server/startup-check';
import { startTieringScheduler } from '$server/tiering';
import { eq } from 'drizzle-orm';

// 模块级启动校验：生产环境配置错误（弱/缺失 SESSION_SECRET、未设 INITIAL_INVITE_CODE）即 fail-fast
validateStartupConfig();
// 冷热分层调度：未配置对象存储时 no-op，行为与现状一致
startTieringScheduler();

export const handle: Handle = async ({ event, resolve }) => {
    const session = readSession(event.cookies);
    if (session) {
        const user = db
            .select()
            .from(schema.users)
            .where(eq(schema.users.id, session.userId))
            .get();
        if (user) {
            event.locals.user = {
                id: user.id,
                email: user.email,
                role: user.role,
                createdAt: user.createdAt
            };
        }
    }
    const response = await resolve(event);
    // 访问日志：排障（含 CSRF 403 场景的 Origin 头取证）走 stdout/stderr——systemd 部署
    // 由 unit 重定向到 /var/log/remote-reader/app.log（见 scripts/install.sh）；静态资源不记。
    // ISO 时间戳必须带（journald 自带时间，文件 append 没有）
    if (!event.url.pathname.startsWith('/_app/')) {
        const origin = event.request.headers.get('origin');
        let ip: string;
        try {
            ip = event.getClientAddress();
        } catch {
            ip = '?';
        }
        console.log(`[access] ${new Date().toISOString()} ${event.request.method} ${event.url.pathname} ${response.status} ip=${ip}${origin ? ` origin=${origin}` : ''}`);
    }
    return response;
};
