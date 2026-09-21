import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            $server: r('./apps/web/src/lib/server'),
            $shared: r('./packages/shared/src'),
            $components: r('./apps/web/src/lib/components'),
            $lib: r('./apps/web/src/lib')
        }
    },
    // vitest 4 把 pool/poolOptions 从 test 节移到顶层（放 test 下会被静默忽略并打 DEPRECATED）。
    // fileParallelism:false 在 vitest 4 不再保证单进程——每文件独立 fork 并行，跨文件共享
    // ./data/app.db 的 resetDb 互踩（间歇性 FK 失败）。singleFork 强制全部文件跑在同一 fork。
    pool: 'forks',
    poolOptions: { forks: { singleFork: true } },
    test: {
        environment: 'node',
        fileParallelism: false,
        include: [
            'packages/shared/src/**/*.test.ts',
            'apps/web/tests/**/*.test.ts',
            'apps/mcp-bridge/tests/**/*.test.ts'
        ],
        exclude: ['node_modules', '**/.svelte-kit', '**/build', '**/dist']
    }
});
