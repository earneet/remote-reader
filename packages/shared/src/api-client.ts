export class ApiError extends Error {
    constructor(public status: number, message: string) {
        super(message);
        this.name = 'ApiError';
    }
}

export interface ApiClient {
    uploadDocument(input: { name: string; content: string; path?: string }): Promise<{ id: string; url: string }>;
}

function mapMessage(status: number, msg: string | undefined): string {
    switch (status) {
        case 400:
            return msg ? `请求非法：${msg}` : '请求非法（name/path 含非法字符或字段缺失）';
        case 401:
            return 'API token 无效或已撤销';
        case 413:
            return '内容超过大小上限';
        case 429:
            return '上传过于频繁，请稍后重试';
        default:
            return `上传失败：HTTP ${status}`;
    }
}

export function createApiClient(opts: { baseUrl: string; token: string }): ApiClient {
    const baseUrl = opts.baseUrl.replace(/\/+$/, '');
    return {
        async uploadDocument({ name, content, path }) {
            let res: Response;
            try {
                res = await fetch(`${baseUrl}/api/v1/documents`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${opts.token}`,
                        'Content-Type': 'application/json'
                    },
                    body: JSON.stringify(path ? { name, content, path } : { name, content })
                });
            } catch (e) {
                throw new ApiError(0, `无法连接服务器：${(e as Error).message}`);
            }
            const text = await res.text();
            let body: any = {};
            try {
                body = text ? JSON.parse(text) : {};
            } catch {
                body = {};
            }
            if (!res.ok) {
                const msg = typeof body?.error?.message === 'string' ? body.error.message : undefined;
                throw new ApiError(res.status, mapMessage(res.status, msg));
            }
            if (typeof body?.id !== 'string' || typeof body?.url !== 'string') {
                throw new ApiError(res.status, '上传成功但响应格式异常');
            }
            return { id: body.id, url: body.url };
        }
    };
}
