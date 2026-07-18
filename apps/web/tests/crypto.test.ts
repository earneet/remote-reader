import { test, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import { sign, verify } from '../src/lib/server/crypto';

// 镜像 readSecret 的 dev 默认，构造合法签名以测试 verify 的内部守卫
function forge(payload: object): string {
    const secret = process.env.SESSION_SECRET || 'dev-insecure-secret';
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const sig = createHmac('sha256', secret).update(body).digest('hex');
    return `${body}.${sig}`;
}

test('sign→verify round-trip 返回 userId', () => {
    const token = sign({ userId: 'user-123' });
    expect(verify(token)).toEqual({ userId: 'user-123' });
});

test('篡改签名 → null', () => {
    const token = sign({ userId: 'user-123' });
    const [body, sig] = token.split('.');
    expect(verify(`${body}.${sig.slice(0, -2)}XX`)).toBeNull();
});

test('签名长度异常 → null', () => {
    const token = sign({ userId: 'user-123' });
    expect(verify(`${token.split('.')[0]}.deadbeef`)).toBeNull();
});

test('缺段 → null', () => {
    expect(verify('')).toBeNull();
    expect(verify('onlybody')).toBeNull();
});

test('换 body（签名不匹配）→ null', () => {
    const real = sign({ userId: 'user-123' });
    const forgedBody = forge({ userId: 'admin', exp: Date.now() + 1e9 }).split('.')[0];
    expect(verify(`${forgedBody}.${real.split('.')[1]}`)).toBeNull();
});

test('非 string userId（签名有效）→ null', () => {
    const token = forge({ userId: 123, exp: Date.now() + 1e9 });
    expect(verify(token)).toBeNull();
});

test('缺 exp（签名有效）→ null', () => {
    const token = forge({ userId: 'u' });
    expect(verify(token)).toBeNull();
});

test('过期 token → null', () => {
    const prev = process.env.SESSION_MAX_AGE;
    process.env.SESSION_MAX_AGE = '-1';
    try {
        const token = sign({ userId: 'u' });
        expect(verify(token)).toBeNull();
    } finally {
        if (prev === undefined) delete process.env.SESSION_MAX_AGE;
        else process.env.SESSION_MAX_AGE = prev;
    }
});
