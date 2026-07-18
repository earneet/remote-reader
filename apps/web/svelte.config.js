import adapter from '@sveltejs/adapter-node';
import { vitePreprocess } from '@sveltejs/vite-plugin-svelte';

const config = {
    preprocess: vitePreprocess(),
    kit: {
        adapter: adapter(),
        alias: {
            $shared: '../../packages/shared/src',
            $server: 'src/lib/server',
            $components: 'src/lib/components'
        }
    }
};

export default config;
