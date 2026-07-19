import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface BridgeConfig {
    baseUrl: string;
    token: string;
}

function configFilePath(): string {
    const xdg = process.env.XDG_CONFIG_HOME;
    const base = xdg ? join(xdg, 'remote-reader') : join(homedir(), '.config', 'remote-reader');
    return join(base, 'config.json');
}

export function loadConfig(): BridgeConfig {
    let fileUrl: string | undefined;
    let fileToken: string | undefined;
    const file = configFilePath();
    if (existsSync(file)) {
        try {
            const parsed = JSON.parse(readFileSync(file, 'utf-8'));
            if (typeof parsed?.baseUrl === 'string') fileUrl = parsed.baseUrl;
            if (typeof parsed?.token === 'string') fileToken = parsed.token;
        } catch {
            // 配置文件损坏：忽略，靠 env 兜底
        }
    }
    const baseUrl = (process.env.REMOTE_READER_URL || fileUrl || '').trim();
    const token = (process.env.REMOTE_READER_TOKEN || fileToken || '').trim();
    if (!baseUrl || !token) {
        console.error(
            '[remote-reader] 缺少配置：需要 baseUrl 与 token。\n' +
            '  方式一：设环境变量 REMOTE_READER_URL 与 REMOTE_READER_TOKEN。\n' +
            `  方式二：写配置文件 ${file}，内容 {"baseUrl":"https://...","token":"rr_..."}。`
        );
        process.exit(1);
    }
    return { baseUrl, token };
}
