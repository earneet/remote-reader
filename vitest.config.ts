import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const r = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
    resolve: {
        alias: {
            $server: r('./apps/web/src/lib/server'),
            $shared: r('./packages/shared/src'),
            $components: r('./apps/web/src/lib/components')
        }
    },
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
