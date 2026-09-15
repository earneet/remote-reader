import { fail, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { listTags, renameTag, deleteTag } from '$server/tags';

export const load: PageServerLoad = async ({ locals }) => {
    if (!locals.user) redirect(302, '/login');
    return { tags: listTags(locals.user.id) };
};

export const actions: Actions = {
    // fail() 而非 error()：error() 信封在前端 enhance 无分支会静默失败（F3，对齐 P2-10 模式）
    rename: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const oldName = String(form.get('old') ?? '');
        const newName = String(form.get('name') ?? '').trim();
        if (!oldName || !newName) return fail(400, { error: '参数缺失' });
        const r = renameTag(locals.user.id, oldName, newName);
        if (!r.ok) {
            if (r.code === 'conflict') return fail(409, { error: '同名标签已存在' });
            if (r.code === 'invalid') return fail(400, { error: '标签名非法' });
            return fail(404, { error: '标签不存在' });
        }
        return { ok: true };
    },
    delete: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const name = String(form.get('name') ?? '');
        if (!name) return fail(400, { error: '参数缺失' });
        deleteTag(locals.user.id, name);
        return { ok: true };
    }
};
