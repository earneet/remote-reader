import { test, expect } from 'vitest';
const { GET } = await import('../src/routes/api/health/+server');

test('GET /api/health DB 可用时返回 200 {ok:true}', async () => {
    const r = await GET({} as Parameters<typeof GET>[0]);
    expect(r.status).toBe(200);
    const body = await r.json();
    expect(body.ok).toBe(true);
});
