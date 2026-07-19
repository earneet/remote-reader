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
        },
        csp: {
            // H6: CSP 作为 markdown-it html:false 之后的第二道防线。
            // 先以 report-only 上线（不阻塞 mermaid 的 eval / katex·mermaid 的 inline-style 需求），
            // 观察实际违规后收紧为 enforcing。script-src 仍排除外域与 inline <script>。
            reportOnly: {
                'default-src': ["'self'"],
                'script-src': ["'self'", "'unsafe-eval'"],
                'style-src': ["'self'", "'unsafe-inline'"],
                'img-src': ["'self'", 'data:'],
                'font-src': ["'self'", 'data:'],
                'connect-src': ["'self'"],
                'worker-src': ["'self'", 'blob:'],
                'base-uri': ["'none'"],
                'form-action': ["'self'"]
            }
        }
    }
};

export default config;
