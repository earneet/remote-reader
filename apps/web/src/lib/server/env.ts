export function envInt(key: string, def: number): number {
    const raw = process.env[key];
    if (raw === undefined || raw === '') return def;
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`env ${key} 必须是正整数，实际值: ${JSON.stringify(raw)}`);
    }
    return n;
}

export function getBaseUrl(): string {
    // 尾斜杠归一化：拼接 `${getBaseUrl()}/s/${token}` 时防产生 `//s/<token>` 双斜杠链接（实测 404）
    return (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '');
}

// 登录页 Agent 指引块展示的桥源码克隆地址（Agent 自动安装用）
export function getBridgeRepoUrl(): string {
    return (process.env.BRIDGE_REPO_URL ?? 'https://github.com/earneet/remote-reader').replace(/\/+$/, '');
}

// DATA_DIR 保持调用时读取（而非模块级常量）——测试需逐文件覆写 process.env.DATA_DIR
export function getDataDir(): string {
    return process.env.DATA_DIR ?? './data/documents';
}

export function getSessionMaxAgeSeconds(): number {
    return envInt('SESSION_MAX_AGE', 2_592_000);
}

export function getColdTierAfterDays(): number {
    return envInt('COLD_TIER_AFTER_DAYS', 30);
}

// —— 图片支持（spec 2026-09-20 §12）——
export type ImageStoreBackend = 'local' | 's3';

export function getImageStoreBackend(): ImageStoreBackend {
    const raw = process.env.IMAGE_STORE_BACKEND ?? 'local';
    if (raw !== 'local' && raw !== 's3') {
        throw new Error(`env IMAGE_STORE_BACKEND 须为 local 或 s3，实际值: ${JSON.stringify(raw)}`);
    }
    return raw;
}

export function getMaxImageBytes(): number {
    return envInt('MAX_IMAGE_BYTES', 10 * 1024 * 1024);
}

// 取图签名有效期秒（桶对齐下实际最短有效期 = TTL，同桶内 URL 稳定复用——spec §7.3/§12）
export function getImageSignedUrlTtl(): number {
    return envInt('IMAGE_SIGNED_URL_TTL', 3600);
}

// 强制全代理（隐蔽优先：不向读者暴露云存储域名；默认 0 = 直连，spec #10）
export function getImageProxyAll(): boolean {
    const raw = process.env.IMAGE_PROXY_ALL ?? '0';
    if (raw !== '0' && raw !== '1') {
        throw new Error(`env IMAGE_PROXY_ALL 须为 0 或 1，实际值: ${JSON.stringify(raw)}`);
    }
    return raw === '1';
}
