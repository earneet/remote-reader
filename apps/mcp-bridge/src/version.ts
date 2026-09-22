import { readFileSync } from 'node:fs';

// 从包根 package.json 读版本：src/ 源码运行与 dist/index.js 打包产物两形态下，
// new URL('../package.json', import.meta.url) 都指向包根（npm tarball 恒含 package.json，
// esbuild 对该表达式保留运行时语义不静态内联）。读不到/解析失败兜底 0.0.0。
export function getBridgeVersion(): string {
    try {
        const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8')) as { version?: unknown };
        if (typeof pkg.version === 'string' && pkg.version) return pkg.version;
    } catch {
        // 兜底：不 fail-fast——版本识别缺失不应阻断桥启动（stderr 记录，不污染 MCP stdio 通道）
        console.error('[remote-reader] 读取桥版本失败，按 0.0.0 处理');
    }
    return '0.0.0';
}
