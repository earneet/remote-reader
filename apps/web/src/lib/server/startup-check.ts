import { parseObjectStoreEnv } from './object-store';
import { sqlite } from './db';
import { envInt } from './env';

const WEAK_SECRET = /^change-me|^dev-insecure|insecure|placeholder|example|^secret$|^password$/i;

// 与 adapter-node files/utils.js parse_as_bytes 同语义（尾字符 K/M/G 按 1024 进制），保证校验值与运行时一致
function parseBodySizeLimitBytes(raw: string): number {
    const units: Record<string, number> = { K: 1024, M: 1024 ** 2, G: 1024 ** 3 };
    const last = raw[raw.length - 1]?.toUpperCase();
    const unit = last !== undefined && last in units ? units[last] : 1;
    return Number(unit !== 1 ? raw.slice(0, -1) : raw) * unit;
}

// M3/H4：生产启动 fail-fast——拒弱 SESSION_SECRET（占位值/过短）与未设/占位 INITIAL_INVITE_CODE。
// dev 不校验。在 hooks.server.ts 模块级调用，使配置错误时服务拒绝启动而非带病运行。
export function validateStartupConfig(): void {
    // 冷热分层：任一 OBJECT_STORE_* 已配置但组合不完整 → fail-fast（全环境；确定性配置错误，spec §12）
    const objectStore = parseObjectStoreEnv();
    // 图片支持（spec §12）：IMAGE_STORE_BACKEND=s3 需要 OBJECT_STORE_* 齐全——确定性配置错误，全环境 fail-fast
    if (process.env.IMAGE_STORE_BACKEND === 's3' && objectStore === null) {
        throw new Error('IMAGE_STORE_BACKEND=s3 需 OBJECT_STORE_* 五项配置齐全（endpoint/region/bucket/accessKeyId/secretAccessKey）');
    }
    // 存量冷文档 + 未配置对象存储 → 这些文档将 503 直至恢复配置（数据仍在桶中，可恢复）：warn 不阻塞
    if (objectStore === null) {
        const cold = (sqlite.prepare("SELECT COUNT(*) AS c FROM documents WHERE storage_tier = 'cold'")
            .get() as { c: number }).c;
        if (cold > 0) {
            console.warn(`[startup] 存在 ${cold} 篇已归档文档但未配置 OBJECT_STORE_*，这些文档将不可读（503）直至恢复对象存储配置`);
        }
    }

    if (process.env.NODE_ENV !== 'production') return;

    const secret = process.env.SESSION_SECRET;
    if (!secret) throw new Error('SESSION_SECRET 生产环境必填');
    if (secret.length < 32) {
        throw new Error(`SESSION_SECRET 长度 ${secret.length} < 32，请用 openssl rand -hex 32 生成强随机值`);
    }
    if (WEAK_SECRET.test(secret)) {
        throw new Error('SESSION_SECRET 不可使用占位/弱值（如 .env.example 的 change-me-to-a-long-random-string）');
    }

    const invite = process.env.INITIAL_INVITE_CODE;
    if (!invite || invite === 'change-me' || invite.length < 6) {
        throw new Error('INITIAL_INVITE_CODE 生产环境必须设置为非默认的强邀请码（>=6 字符），否则首个 admin 无法注册或会被抢注');
    }

    // M14 补强：BASE_URL 默认 localhost 会让上传返回的 /s/<token> 链接用户打不开，生产必须显式设为可达公网地址。
    const baseUrl = process.env.BASE_URL;
    if (!baseUrl) {
        throw new Error('BASE_URL 生产环境必填（用于生成 /s/<token> 查看链接，遗漏会导致返回 localhost 链接用户无法打开）');
    }
    let hostname: string;
    try {
        hostname = new URL(baseUrl).hostname;
    } catch {
        throw new Error(`BASE_URL "${baseUrl}" 不是合法 URL`);
    }
    if (hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '0.0.0.0' || hostname === '::1') {
        throw new Error(`BASE_URL 生产环境不可指向本地地址 (${hostname})，请改为公网/反代地址`);
    }

    // adapter-node 的 CSRF Origin 校验：form POST 的 Origin 头必须等于服务端认知的 url.origin。
    // 未设 ORIGIN 时按「protocol 默认 https + Host 头」推断，反代/直连形态下几乎必与浏览器 Origin
    // 不匹配 → 登出/登录/注册等全部表单 POST 被 403（Cross-site POST form submissions are forbidden）。
    // 与 BASE_URL 几乎恒同值（install.sh 已同步写入），生产必填且须同源（防占位值漂移）。
    const origin = process.env.ORIGIN;
    if (!origin) {
        throw new Error(
            'ORIGIN 生产环境必填（adapter-node CSRF Origin 校验基准；漏设会导致全部表单 POST 被 403 Cross-site forbidden）——与 BASE_URL 同值即可，如 https://your-host'
        );
    }
    let originUrl: URL;
    try {
        originUrl = new URL(origin);
    } catch {
        throw new Error(`ORIGIN "${origin}" 不是合法 URL`);
    }
    if (originUrl.origin !== new URL(baseUrl).origin) {
        throw new Error(`ORIGIN "${origin}" 与 BASE_URL "${baseUrl}" 不同源，须一致（如均为 https://your-host）`);
    }
    // adapter-node BODY_SIZE_LIMIT 默认仅 512K：须覆盖文档 JSON 与图片 base64（×1.37）两类上限（spec §12 双下限取 max）
    const rawLimit = process.env.BODY_SIZE_LIMIT;
    const limit = parseBodySizeLimitBytes(rawLimit ?? '512K');
    const maxUpload = envInt('MAX_UPLOAD_BYTES', 5 * 1024 * 1024);
    const maxImage = envInt('MAX_IMAGE_BYTES', 10 * 1024 * 1024);
    const need = Math.max(maxUpload * 1.5, Math.ceil(maxImage * 1.37 * 1.5));
    if (!Number.isFinite(limit) || limit < need) {
        throw new Error(
            `BODY_SIZE_LIMIT "${rawLimit ?? '512K'}"(${limit}B) 须 ≥ max(MAX_UPLOAD_BYTES×1.5, MAX_IMAGE_BYTES×1.37×1.5)=${need}B——` +
                '否则超限上传会被 adapter 在路由前拦成 400/413，排障方向被带偏；如 5M 文档+10M 图片配 24M（25165824）'
        );
    }
}
