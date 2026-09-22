export class ApiError extends Error {
    public retryAfter?: number;
    constructor(public status: number, message: string, retryAfter?: number) {
        super(message);
        this.name = 'ApiError';
        this.retryAfter = retryAfter;
    }
}

// 图片上传慢链路（10MB base64 ≈13MB / 直传字节）需远大于文档 60s——spec §6.2
export const IMAGE_TIMEOUT_MS = 300_000;

/** initImage 三态（Phase 2 路由 json(result) 原样——响应是 camelCase） */
type InitImageResult =
    | { status: 'exists'; name: string }
    | { status: 'relay'; name: string; imageId: string }
    | { status: 'direct'; name: string; imageId: string; uploadUrl: string };

export interface ApiClient {
    uploadDocument(input: { name: string; content: string; path?: string }): Promise<{ id: string; url: string; warnings?: string[]; minBridgeVersion?: string }>;
    initImage(input: { name: string; contentHash: string; contentMd5: string; sizeBytes: number }): Promise<InitImageResult>;
    relayImage(input: { imageId: string; contentBase64: string }): Promise<{ name: string }>;
    confirmImage(input: { imageId: string }): Promise<{ status: 'ok'; name: string }>;
    putImageBytes(uploadUrl: string, data: Buffer): Promise<void>;
}

interface UploadResponse {
    id?: string;
    url?: string;
    // 服务端检测到未随文档上传的本地图片引用时返回（旧桥裂图提示）
    warnings?: unknown;
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

// P2-1：messageFrom 提取器——invalid 响应是 {status:'invalid',reason} 而非 error() 的 {message}，
// 由各图片方法注入（requestJson 保持通用，uploadDocument 不传走默认 message）
async function requestJson<T>(
    url: string, init: RequestInit, timeoutMs: number,
    messageFrom?: (body: Record<string, unknown>) => string | undefined
): Promise<{ status: number; headers: Headers; body: T }> {
    let res: Response;
    try {
        res = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (e) {
        const n = (e as Error)?.name;
        if (n === 'TimeoutError' || n === 'AbortError') {
            throw new ApiError(0, `请求超时（${Math.round(timeoutMs / 1000)}s），请检查网络后重试`);
        }
        throw new ApiError(0, `无法连接服务器：${(e as Error).message}`);
    }
    const text = await res.text();
    let body: Record<string, unknown> = {};
    try { body = text ? JSON.parse(text) : {}; } catch { body = {}; }
    if (!res.ok) {
        const ra = res.headers.get('retry-after');
        const retryAfter = ra !== null && /^\d+$/.test(ra) ? Number(ra) : undefined;
        const msg = messageFrom ? messageFrom(body) : (body as { message?: string }).message;
        throw new ApiError(res.status, mapMessage(res.status, msg), retryAfter);
    }
    return { status: res.status, headers: res.headers, body: body as T };
}

// P2-1：relay/confirm 的 400 invalid wire 形状 {status:'invalid',reason} 的 reason 提取
const imageReasonFrom = (body: Record<string, unknown>): string | undefined =>
    typeof body.reason === 'string' ? body.reason : undefined;

export function createApiClient(opts: { baseUrl: string; token: string; userAgent?: string }): ApiClient {
    const baseUrl = opts.baseUrl.replace(/\/+$/, '');
    // UA 声明桥版本（服务端 access log 识别 + 兼容判断）；可选——putImageBytes 除外（第三方 presigned URL）
    const uaHeader: Record<string, string> = opts.userAgent ? { 'User-Agent': opts.userAgent } : {};
    const jsonHeaders = (): Record<string, string> => ({
        Authorization: `Bearer ${opts.token}`,
        'Content-Type': 'application/json',
        ...uaHeader
    });
    return {
        async uploadDocument({ name, content, path }) {
            let res: Response;
            try {
                res = await fetch(`${baseUrl}/api/v1/documents`, {
                    method: 'POST',
                    headers: {
                        Authorization: `Bearer ${opts.token}`,
                        'Content-Type': 'application/json',
                        ...uaHeader
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
            // warnings 仅在确为字符串数组时透传（服务端扩展字段，脏数据不外溢）
            const warnings = Array.isArray(body.warnings) && body.warnings.every((w) => typeof w === 'string')
                ? body.warnings
                : undefined;
            // 服务端建议的最低桥版本（响应头，缺头不透传）
            const minBridgeVersion = res.headers.get('x-remote-reader-min-bridge') ?? undefined;
            return { id: body.id, url: body.url, warnings, minBridgeVersion };
        },
        // 图片三方法 wire 键名一律 snake_case（P1-3，与 Phase 2 路由对齐）；接口 camelCase 显式映射
        async initImage({ name, contentHash, contentMd5, sizeBytes }) {
            const { body } = await requestJson<InitImageResult>(
                `${baseUrl}/api/v1/images/init`,
                {
                    method: 'POST',
                    headers: jsonHeaders(),
                    body: JSON.stringify({ name, content_hash: contentHash, content_md5: contentMd5, size_bytes: sizeBytes })
                },
                IMAGE_TIMEOUT_MS
            );
            return body;
        },
        async relayImage({ imageId, contentBase64 }) {
            const { body } = await requestJson<{ name: string }>(
                `${baseUrl}/api/v1/images`,
                {
                    method: 'POST',
                    headers: jsonHeaders(),
                    body: JSON.stringify({ image_id: imageId, content_base64: contentBase64 })
                },
                IMAGE_TIMEOUT_MS,
                imageReasonFrom
            );
            return body;
        },
        async confirmImage({ imageId }) {
            const { body } = await requestJson<{ status: 'ok'; name: string }>(
                `${baseUrl}/api/v1/images/confirm`,
                {
                    method: 'POST',
                    headers: jsonHeaders(),
                    body: JSON.stringify({ image_id: imageId })
                },
                IMAGE_TIMEOUT_MS,
                imageReasonFrom
            );
            return body;
        },
        async putImageBytes(uploadUrl, data) {
            let res: Response;
            try {
                // P1-2：presigned PUT 是第三方云 URL——S3 SigV4 query 签名与 header 认证互斥（带即 400），
                // 且发送 Bearer 会把服务器 API token 外泄给云厂商；presign 未签 Content-Type → 不发该头。
                // new Uint8Array 拷贝仅为类型兼容（桥 @types/node 22 下 Buffer<ArrayBufferLike> 不满足
                // BodyInit），毫秒级拷贝换取双工具链（桥 tsc/vitest node）一致编译
                res = await fetch(uploadUrl, { method: 'PUT', body: new Uint8Array(data), signal: AbortSignal.timeout(IMAGE_TIMEOUT_MS) });
            } catch (e) {
                const name = (e as Error)?.name;
                if (name === 'TimeoutError' || name === 'AbortError') {
                    throw new ApiError(0, `请求超时（${Math.round(IMAGE_TIMEOUT_MS / 1000)}s），请检查网络后重试`);
                }
                throw new ApiError(0, `无法连接服务器：${(e as Error).message}`);
            }
            if (res.status < 200 || res.status >= 300) {
                throw new ApiError(res.status, `图片直传失败：HTTP ${res.status}`);
            }
        }
    };
}
