import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        environment: 'node',
        include: [
            'packages/shared/src/**/*.test.ts',
            'apps/web/tests/**/*.test.ts'
        ],
        exclude: ['node_modules', '**/.svelte-kit', '**/build', '**/dist']
    }
});
