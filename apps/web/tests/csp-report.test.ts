import { describe, it, expect } from 'vitest';
import { POST } from '../src/routes/api/csp-report/+server';

function makeRequest(body: unknown, contentType = 'application/json'): Request {
    return new Request('http://localhost/api/csp-report', {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: typeof body === 'string' ? body : JSON.stringify(body)
    });
}

describe('POST /api/csp-report', () => {
    it('正常违规报告 → 204', async () => {
        const res = await POST({ request: makeRequest({ 'csp-report': { 'violated-directive': 'script-src' } }) } as any);
        expect(res.status).toBe(204);
        expect(await res.text()).toBe('');
    });

    it('畸形 body（非 JSON）→ 仍 204，不抛错', async () => {
        const res = await POST({ request: makeRequest('not-json', 'text/plain') } as any);
        expect(res.status).toBe(204);
    });
});
