import type { Handle } from '@sveltejs/kit';
import { db, schema } from '$server/db';
import { readSession } from '$server/session';
import { validateStartupConfig } from '$server/startup-check';
import { eq } from 'drizzle-orm';

// 模块级启动校验：生产环境配置错误（弱/缺失 SESSION_SECRET、未设 INITIAL_INVITE_CODE）即 fail-fast
validateStartupConfig();

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
    return resolve(event);
};
