import { test, expect } from 'vitest';
import { setSessionCookie, clearSessionCookie, readSession } from '../src/lib/server/session';

function mockCookies() {
    const store: Record<string, string> = {};
    const setCalls: Array<{ name: string; value: string; opts?: Record<string, unknown> }> = [];
    return {
        set: (name: string, value: string, opts?: Record<string, unknown>) => {
            store[name] = value;
            setCalls.push({ name, value, opts });
        },
        get: (name: string) => store[name],
        delete: (name: string) => {
            delete store[name];
        },
        _store: store,
        _setCalls: setCalls
    };
}

test('readSession：无 cookie 返回 null', () => {
    expect(readSession(mockCookies() as never)).toBe(null);
});

test('setSessionCookie + readSession 往返正确', () => {
    const c = mockCookies();
    setSessionCookie(c as never, { userId: 'user-123' });
    expect(readSession(c as never)).toEqual({ userId: 'user-123' });
});

test('readSession：签名被篡改返回 null', () => {
    const c = mockCookies();
    setSessionCookie(c as never, { userId: 'user-123' });
    c._store.session = c._store.session.slice(0, -2) + 'xx';
    expect(readSession(c as never)).toBe(null);
});

test('readSession：格式错误返回 null', () => {
    const c = mockCookies();
    c._store.session = 'not-a-valid-token';
    expect(readSession(c as never)).toBe(null);
});

test('clearSessionCookie：删除 session cookie', () => {
    const c = mockCookies();
    setSessionCookie(c as never, { userId: 'user-123' });
    expect(c._store.session).toBeTruthy();
    clearSessionCookie(c as never);
    expect(c._store.session).toBeUndefined();
});

test('setSessionCookie：cookie 选项安全（httpOnly / sameSite=lax / path=/ / maxAge>0）', () => {
    const c = mockCookies();
    setSessionCookie(c as never, { userId: 'user-123' });
    const opts = c._setCalls[0].opts!;
    expect(opts.httpOnly).toBe(true);
    expect(opts.sameSite).toBe('lax');
    expect(opts.path).toBe('/');
    expect(opts.maxAge as number).toBeGreaterThan(0);
});
