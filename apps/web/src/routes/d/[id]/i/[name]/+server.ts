import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$server/db';
import { eq } from 'drizzle-orm';
import { serveImageResponse } from '$server/images';

export const GET: RequestHandler = async ({ params, request, setHeaders, locals }) => {
    if (!locals.user) error(401, '未登录');
    const doc = db.select({ ownerId: schema.documents.ownerId }).from(schema.documents)
        .where(eq(schema.documents.id, params.id)).get();
    if (!doc || doc.ownerId !== locals.user.id) error(404, 'Not Found');
    return serveImageResponse({ request, setHeaders, ownerId: doc.ownerId, documentId: params.id, name: params.name });
};
