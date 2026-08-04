import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { listTags, renameTag, deleteTag } from '$server/tags';

export const load: PageServerLoad = async ({ locals }) => {
    if (!locals.user) redirect(302, '/login');
    return { tags: listTags(locals.user.id) };
};

export const actions: Actions = {
    rename: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const oldName = String(form.get('old') ?? '');
        const newName = String(form.get('name') ?? '').trim();
        if (!oldName || !newName) error(400, '参数缺失');
        const r = renameTag(locals.user.id, oldName, newName);
        if (!r.ok) {
            if (r.code === 'conflict') error(409, '同名标签已存在');
            if (r.code === 'invalid') error(400, '标签名非法');
            error(404, '标签不存在');
        }
        return { ok: true };
    },
    delete: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const name = String(form.get('name') ?? '');
        if (!name) error(400, '参数缺失');
        deleteTag(locals.user.id, name);
        return { ok: true };
    }
};
