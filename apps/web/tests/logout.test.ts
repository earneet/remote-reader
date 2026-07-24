import { test, expect } from 'vitest';
import { setSessionCookie } from '../src/lib/server/session';

const { POST } = await import('../src/routes/logout/+server');

function mockCookies() {
    const store: Record<string, string> = {};
    return {
        set: (name: string, value: string) => {
            store[name] = value;
        },
        get: (name: string) => store[name],
        delete: (name: string) => {
            delete store[name];
        },
        _store: store
    };
}

test('POST 清除 session cookie 并 redirect 303 到 /', async () => {
    const c = mockCookies();
    setSessionCookie(c as never, { userId: 'u1' });
    expect(c._store.session).toBeTruthy();
    await expect(POST({ cookies: c as never } as never)).rejects.toMatchObject({ status: 303 });
    expect(c._store.session).toBeUndefined();
});
