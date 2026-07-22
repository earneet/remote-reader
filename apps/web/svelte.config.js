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
            // H6: CSP 作为 markdown-it html:false 之后的第二道防线；report-only 先观察不阻断。
            // report-uri 为必填 directive，缺失会致 SvelteKit CspReportOnlyProvider 构造期抛错、全站 500。
            reportOnly: {
                'default-src': ["'self'"],
                'script-src': ["'self'", "'unsafe-eval'"],
                'style-src': ["'self'", "'unsafe-inline'"],
                'img-src': ["'self'", 'data:'],
                'font-src': ["'self'", 'data:'],
                'connect-src': ["'self'"],
                'worker-src': ["'self'", 'blob:'],
                'base-uri': ["'none'"],
                'form-action': ["'self'"],
                'report-uri': ['/api/csp-report']
            }
        }
    }
};

export default config;
