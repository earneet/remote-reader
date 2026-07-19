const WEAK_SECRET = /^change-me|^dev-insecure|insecure|placeholder|example|^secret$|^password$/i;

// M3/H4：生产启动 fail-fast——拒弱 SESSION_SECRET（占位值/过短）与未设/占位 INITIAL_INVITE_CODE。
// dev 不校验。在 hooks.server.ts 模块级调用，使配置错误时服务拒绝启动而非带病运行。
export function validateStartupConfig(): void {
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
}
