import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDocumentIdByShareToken } from '$server/shares';
import { db, schema } from '$server/db';
import { eq } from 'drizzle-orm';
import { serveImageResponse } from '$server/images';

export const GET: RequestHandler = async ({ params, request, setHeaders }) => {
    const documentId = getDocumentIdByShareToken(params.token);
    if (!documentId) error(404, 'Not Found');
    const doc = db.select({ ownerId: schema.documents.ownerId }).from(schema.documents)
        .where(eq(schema.documents.id, documentId)).get();
    if (!doc) error(404, 'Not Found');
    return serveImageResponse({ request, setHeaders, ownerId: doc.ownerId, documentId, name: params.name });
};
