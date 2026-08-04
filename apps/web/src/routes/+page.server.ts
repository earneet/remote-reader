import { error, redirect } from '@sveltejs/kit';
import { and, eq, isNull } from 'drizzle-orm';
import type { Actions, PageServerLoad } from './$types';
import { generateId } from '$server/auth';
import { db, schema } from '$server/db';
import { deleteNode, listChildren, listFolders, moveNode, renameNode } from '$server/documents';
import { listTags, listTagsForDocs, setDocTags, SetTagsError } from '$server/tags';
import { parsePath } from '@remote-reader/shared/paths';

// M10: 文件管理器输入也经 sanitize，与 API 上传语义一致。名称必须是单段合法名。
function sanitizeSingleName(raw: string): string {
    const parts = parsePath(raw);
    if (parts.length !== 1) throw new Error('名称不能包含路径分隔符');
    return parts[0];
}

export const load: PageServerLoad = async ({ locals, url }) => {
    if (!locals.user) redirect(302, '/login');
    const dir = url.searchParams.get('dir');
    const parentId = dir && dir.length > 0 ? dir : null;
    const children = listChildren(locals.user.id, parentId);
    const folders = listFolders(locals.user.id);
    const fileIds = children.filter(c => c.type === 'file').map(c => c.id);
    const tagsByDoc = listTagsForDocs(fileIds, locals.user.id);
    return { children, folders, currentDir: parentId, tagsByDoc, allTags: listTags(locals.user.id) };
};

export const actions: Actions = {
    createFolder: async ({ request, locals, url }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const rawName = String(form.get('name') ?? '').trim();
        const dir = url.searchParams.get('dir');
        const parentId = dir && dir.length > 0 ? dir : null;
        if (!rawName) error(400, '名称必填');
        let name: string;
        try {
            name = sanitizeSingleName(rawName);
        } catch (e) {
            error(400, (e as Error).message);
        }
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
        const rawName = String(form.get('name') ?? '').trim();
        if (!id || !rawName) error(400, '参数缺失');
        let name: string;
        try {
            name = sanitizeSingleName(rawName);
        } catch (e) {
            error(400, (e as Error).message);
        }
        const r = renameNode(locals.user.id, id, name);
        if (!r.ok) {
            if (r.code === 'conflict') error(409, r.reason ?? '重名');
            error(404, r.reason ?? '文档不存在');
        }
        return { ok: true };
    },
    move: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const id = String(form.get('id') ?? '');
        const target = String(form.get('target') ?? '');
        if (!id) error(400, '参数缺失');
        const newParentId = target === 'root' || !target ? null : target;
        const r = moveNode(locals.user.id, id, newParentId);
        if (!r.ok) {
            if (r.code === 'conflict') error(409, r.reason ?? '目标存在同名');
            error(400, r.reason ?? '移动失败');
        }
        return { ok: true };
    },
    delete: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const id = String(form.get('id') ?? '');
        if (!id) error(400, '参数缺失');
        deleteNode(locals.user.id, id);
        return { ok: true };
    },
    setTags: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const id = String(form.get('id') ?? '');
        const raw = String(form.get('tags') ?? '');
        if (!id) error(400, '参数缺失');
        const names = raw.split(',').map(s => s.trim()).filter(Boolean);
        for (const n of names) {
            const t = n.trim();
            if (!t || t.length > 32 || t.includes('/')) error(400, `标签名非法：${t}`);
        }
        try {
            setDocTags(locals.user.id, id, names);
        } catch (e) {
            if (e instanceof SetTagsError) error(404, '文档不存在或无权操作');
            throw e;
        }
        return { ok: true };
    }
};
