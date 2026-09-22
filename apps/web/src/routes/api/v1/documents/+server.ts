import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { authenticateApiToken } from '$server/apitoken-auth';
import { checkRateLimit } from '$server/ratelimit';
import { uploadDocument, NameConflictError } from '$server/documents';
import { TooManyImageRefsError } from '$server/image-refs';
import { detectUnuploadedLocalImageRefs } from '$server/upload-warnings';
import { MIN_BRIDGE_VERSION } from '$server/bridge-compat';
import { parsePath } from '@remote-reader/shared/paths';
import { envInt } from '$server/env';

const MAX_BYTES = envInt('MAX_UPLOAD_BYTES', 5 * 1024 * 1024);
// P2-9：防深路径——无上限时数千段 path 会先插数千 folder 行再 ENAMETOOLONG 裸 500
const MAX_PATH_SEGMENTS = 32;
const MAX_PATH_BYTES = 1024;
const RATE_LIMIT = {
    max: envInt('RATE_LIMIT_MAX', 60),
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000)
};
// 认证失败按 IP 限流：防无效 token 无限速枚举（token 256 位熵使暴力不可行，此为纵深防御）。
const AUTH_FAIL_RATE_LIMIT = {
    max: envInt('AUTH_FAIL_RATE_LIMIT_MAX', 30),
    windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60_000)
};

export const POST: RequestHandler = async ({ request, getClientAddress }) => {
    const auth = authenticateApiToken(request.headers.get('authorization'));
    if (!auth) {
        const rl = checkRateLimit(`authfail:${getClientAddress()}`, AUTH_FAIL_RATE_LIMIT);
        if (!rl.allowed) error(429, 'too many failed auth attempts, slow down');
        error(401, 'invalid or missing api token');
    }

    const rl = checkRateLimit(`upload:${auth.tokenId}`, RATE_LIMIT);
    if (!rl.allowed) error(429, 'rate limit exceeded');

    // adapter 在 body 超限时向流注入 SvelteKitError(413)——带 status 的错误须透传，只有真·坏 JSON 才 400
    const body = await request.json().catch((e: unknown) => {
        if (e instanceof Error && typeof (e as { status?: unknown }).status === 'number') throw e;
        error(400, 'invalid json');
    });
    // body 可能是 JSON null/标量（request.json() 不抛）——解构 null 会 TypeError 裸 500，兜成 400
    const { name, content, path } = (body ?? {}) as { name?: string; content?: string; path?: string };

    if (typeof name !== 'string' || !name || typeof content !== 'string') error(400, 'name and content required');
    if (path !== undefined && typeof path !== 'string') error(400, 'path must be a string');
    if (Buffer.byteLength(content) > MAX_BYTES) error(413, 'document too large');

    // name 与 path 都由 Agent 控制，必须一并过 parsePath：node:path.join 会归一化 ..，
    // 若 name 含 ../ 会逃出 owner 目录甚至 DATA_DIR。末段作文件名，其余作目录前缀。
    let parts: string[];
    try {
        parts = parsePath(path ? `${path}/${name}` : name);
    } catch (e) {
        error(400, (e as Error).message || 'invalid path or name');
    }
    const fileName = parts[parts.length - 1];
    const segments = parts.slice(0, -1);
    if (parts.length > MAX_PATH_SEGMENTS) error(400, `path 过深（>${MAX_PATH_SEGMENTS} 段）`);
    if (Buffer.byteLength(parts.join('/')) > MAX_PATH_BYTES) error(400, `path 过长（>${MAX_PATH_BYTES} 字节）`);

    let result: { id: string; url: string };
    try {
        result = await uploadDocument(auth.userId, fileName, content, segments);
    } catch (e) {
        // P1-4：跨类型同名冲突 → 409（此前是 EISDIR/EEXIST 裸 500）
        if (e instanceof NameConflictError) error(409, e.message);
        // 图片引用数量超限 → 413（与 content 超限同档语义）
        if (e instanceof TooManyImageRefsError) error(413, e.message);
        throw e;
    }
    // Layer ③：最低桥版本建议随响应头下发（桥 compareVersions 自检）；无 warnings 时响应形状零变化
    const headers = { 'X-Remote-Reader-Min-Bridge': MIN_BRIDGE_VERSION };
    // Layer ②：内容兜底检测（旧桥不发 UA）——本地图片引用未随文档上传 → warnings 提示升级
    const { total, listed } = detectUnuploadedLocalImageRefs(auth.userId, result.id, content);
    if (total > 0) {
        return json({
            ...result,
            warnings: [`检测到 ${total} 处本地图片引用未随文档上传（查看页将显示裂图）：${listed.join('、')}${total > listed.length ? '（仅列前 5 处）' : ''}——这通常意味着桥版本过旧（≥0.2.0 起支持图片自动上传），请升级桥后重新上传`]
        }, { headers });
    }
    return json(result, { headers });
};
