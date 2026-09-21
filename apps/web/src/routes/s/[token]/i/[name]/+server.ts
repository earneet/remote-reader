import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getDocumentIdByShareToken } from '$server/shares';
import { db, schema } from '$server/db';
import { eq } from 'drizzle-orm';
import { resolveImageByName } from '$server/images';
import { getBlobStore } from '$server/blobstore';
import { ObjectNotFoundError, ArchiveUnavailableError } from '$server/object-store';

export const GET: RequestHandler = async ({ params, request, setHeaders }) => {
    const documentId = getDocumentIdByShareToken(params.token);
    if (!documentId) error(404, 'Not Found');
    const doc = db.select({ ownerId: schema.documents.ownerId }).from(schema.documents)
        .where(eq(schema.documents.id, documentId)).get();
    if (!doc) error(404, 'Not Found');
    // refs 白名单（spec #8）：该 md 必须引用此图——share token 不能枚举 owner 其他图
    const img = resolveImageByName(doc.ownerId, params.name);
    if (!img) error(404, 'Not Found');
    const refed = db.select({ x: schema.imageRefs.documentId }).from(schema.imageRefs)
        .where(eq(schema.imageRefs.imageId, img.id)).all().some((r) => r.x === documentId);
    if (!refed) error(404, 'Not Found');
    // no-cache 协商（spec #26）：ETag=content_hash，命中 If-None-Match → 304 无 body
    const etag = `"${img.contentHash}"`;
    if (request.headers.get('if-none-match') === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag, 'Cache-Control': 'no-cache' } });
    }
    const store = getBlobStore(img.storageBackend);
    if (!store) error(503, 'image backend unavailable');
    let data: Buffer;
    try {
        data = await store.get(img.storageKey);
    } catch (e) {
        if (e instanceof ObjectNotFoundError) error(404, 'Not Found');
        if (e instanceof ArchiveUnavailableError) error(503, 'image storage unreachable');
        throw e;
    }
    setHeaders({
        'Content-Type': img.mimeType,
        'X-Content-Type-Options': 'nosniff',
        'Cache-Control': 'no-cache',
        ETag: etag
    });
    return new Response(new Uint8Array(data));
};
