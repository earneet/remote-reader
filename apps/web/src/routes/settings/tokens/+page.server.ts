import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { listTokens, createTokenForUser, revokeToken } from '$server/apitokens';

export const load: PageServerLoad = async ({ locals }) => {
    if (!locals.user) redirect(302, '/login');
    return { tokens: listTokens(locals.user.id) };
};

export const actions: Actions = {
    create: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const name = String(form.get('name') ?? '').trim();
        if (!name) error(400, '名称必填');
        const { plaintext } = await createTokenForUser(locals.user.id, name);
        return { plaintext };
    },
    revoke: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const id = String(form.get('id') ?? '');
        if (!id) error(400, '参数缺失');
        revokeToken(locals.user.id, id);
        return { ok: true };
    }
};
