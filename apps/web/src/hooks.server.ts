import type { Handle } from '@sveltejs/kit';
import { db, schema } from '$server/db';
import { readSession } from '$server/session';
import { eq } from 'drizzle-orm';

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
