export class ApiError extends Error {
    constructor(public status: number, message: string) {
        super(message);
        this.name = 'ApiError';
    }
}

export interface ApiClient {
    uploadDocument(input: { name: string; content: string; path?: string }): Promise<{ id: string; url: string }>;
}

interface UploadResponse {
    id?: string;
    url?: string;
    // SvelteKit error() 的真实 wire 形状是扁平 {"message":...}（Accept: */* 协商走 JSON 分支）；
    // error:{message} 为历史兼容形状
    message?: string;
    error?: { message?: string };
}

// 5MB 内容在慢链路（~700kbps）上需 ~60s；无显式超时则在服务端半开连接下无限期挂起工具调用
const UPLOAD_TIMEOUT_MS = 60_000;

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
            // 透传服务端 message（如 409 的“路径段已被同名文件占用”）——否则 Agent 无从自愈
            return msg ? `上传失败：HTTP ${status}：${msg}` : `上传失败：HTTP ${status}`;
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
                    body: JSON.stringify(path ? { name, content, path } : { name, content }),
                    signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS)
                });
            } catch (e) {
                const name = (e as Error)?.name;
                if (name === 'TimeoutError' || name === 'AbortError') {
                    throw new ApiError(0, `上传超时（${UPLOAD_TIMEOUT_MS / 1000}s），请检查网络后重试`);
                }
                throw new ApiError(0, `无法连接服务器：${(e as Error).message}`);
            }
            const text = await res.text();
            let body: UploadResponse = {};
            try {
                body = text ? (JSON.parse(text) as UploadResponse) : {};
            } catch {
                body = {};
            }
            if (!res.ok) {
                throw new ApiError(res.status, mapMessage(res.status, body.message ?? body.error?.message));
            }
            if (typeof body.id !== 'string' || typeof body.url !== 'string') {
                throw new ApiError(res.status, '上传成功但响应格式异常');
            }
            return { id: body.id, url: body.url };
        }
    };
}
