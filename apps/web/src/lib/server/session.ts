import type { Cookies } from '@sveltejs/kit';
import { sign, verify } from './crypto';
import { getSessionMaxAgeSeconds } from './env';

const COOKIE_NAME = 'session';
const MAX_AGE = getSessionMaxAgeSeconds();

export function setSessionCookie(cookies: Cookies, payload: { userId: string }): void {
    const token = sign(payload);
    cookies.set(COOKIE_NAME, token, {
        path: '/',
        httpOnly: true,
        sameSite: 'lax',
        secure: process.env.NODE_ENV === 'production',
        maxAge: MAX_AGE
    });
}

export function clearSessionCookie(cookies: Cookies): void {
    cookies.delete(COOKIE_NAME, { path: '/' });
}

export function readSession(cookies: Cookies): { userId: string } | null {
    const token = cookies.get(COOKIE_NAME);
    if (!token) return null;
    return verify(token);
}

export { COOKIE_NAME };
