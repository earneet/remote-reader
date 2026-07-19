import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import { listSharesByOwner, revokeShare } from '$server/shares';

export const load: PageServerLoad = async ({ locals }) => {
    if (!locals.user) redirect(302, '/login');
    return { shares: listSharesByOwner(locals.user.id) };
};

export const actions: Actions = {
    revoke: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const token = String(form.get('token') ?? '');
        if (!token) error(400, '参数缺失');
        revokeShare(locals.user.id, token);
        return { ok: true };
    }
};
