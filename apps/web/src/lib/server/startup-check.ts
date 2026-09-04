import { parseObjectStoreEnv } from './object-store';
import { sqlite } from './db';

const WEAK_SECRET = /^change-me|^dev-insecure|insecure|placeholder|example|^secret$|^password$/i;

// M3/H4：生产启动 fail-fast——拒弱 SESSION_SECRET（占位值/过短）与未设/占位 INITIAL_INVITE_CODE。
// dev 不校验。在 hooks.server.ts 模块级调用，使配置错误时服务拒绝启动而非带病运行。
export function validateStartupConfig(): void {
    // 冷热分层：任一 OBJECT_STORE_* 已配置但组合不完整 → fail-fast（全环境；确定性配置错误，spec §12）
    const objectStore = parseObjectStoreEnv();
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
}
