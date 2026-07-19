import { redirect } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { clearSessionCookie } from '$server/session';

export const POST: RequestHandler = async ({ cookies }) => {
    clearSessionCookie(cookies);
    redirect(303, '/');
};
