import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad, Actions } from './$types';
import {
    listInvites, createInviteCode, revokeInvite,
    INVITE_EXPIRY_DAYS, type InviteExpiryDays
} from '$server/invites';

// 邀请码管理为 admin 专属（首个注册用户即 admin）；member 一律 403
function requireAdmin(locals: App.Locals) {
    if (!locals.user) redirect(302, '/login');
    if (locals.user.role !== 'admin') error(403, '仅管理员可管理邀请码');
    return locals.user;
}

export const load: PageServerLoad = async ({ locals }) => {
    requireAdmin(locals);
    return { invites: listInvites() };
};

export const actions: Actions = {
    create: async ({ request, locals }) => {
        const admin = requireAdmin(locals);
        const form = await request.formData();
        const note = String(form.get('note') ?? '').trim();
        const days = Number(form.get('days'));
        if (!note) error(400, '备注必填');
        if (!INVITE_EXPIRY_DAYS.includes(days as InviteExpiryDays)) error(400, '有效期不合法');
        const { plaintext } = await createInviteCode(admin.id, note, days as InviteExpiryDays);
        return { plaintext };
    },
    revoke: async ({ request, locals }) => {
        requireAdmin(locals);
        const form = await request.formData();
        const id = String(form.get('id') ?? '');
        if (!id) error(400, '参数缺失');
        revokeInvite(id);
        return { ok: true };
    }
};
