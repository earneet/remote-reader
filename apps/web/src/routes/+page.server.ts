import { error, redirect } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { generateId } from '$server/auth';
import { db, schema } from '$server/db';
import { listChildren, listFolders, renameNode } from '$server/documents';

export const load: PageServerLoad = async ({ locals, url }) => {
    if (!locals.user) redirect(302, '/login');
    const dir = url.searchParams.get('dir');
    const parentId = dir && dir.length > 0 ? dir : null;
    const children = listChildren(locals.user.id, parentId);
    const folders = listFolders(locals.user.id);
    return { children, folders, currentDir: parentId };
};

export const actions: Actions = {
    createFolder: async ({ request, locals, url }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const name = String(form.get('name') ?? '').trim();
        const dir = url.searchParams.get('dir');
        const parentId = dir && dir.length > 0 ? dir : null;
        if (!name) error(400, '名称必填');
        const dup = db.select().from(schema.documents).where(and(
            eq(schema.documents.ownerId, locals.user.id),
            parentId === null ? isNull(schema.documents.parentId) : eq(schema.documents.parentId, parentId),
            eq(schema.documents.name, name),
            eq(schema.documents.type, 'folder')
        )).get();
        if (!dup) {
            const now = Date.now();
            db.insert(schema.documents).values({
                id: generateId(), ownerId: locals.user.id, parentId, name,
                type: 'folder', storagePath: null, contentHash: null, sizeBytes: null,
                createdAt: now, updatedAt: now
            }).run();
        }
        return { ok: true };
    },
    rename: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const id = String(form.get('id') ?? '');
        const name = String(form.get('name') ?? '').trim();
        if (!id || !name) error(400, '参数缺失');
        renameNode(locals.user.id, id, name);
        return { ok: true };
    }
};
