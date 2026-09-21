import MarkdownIt from 'markdown-it';
import { createHighlighter } from 'shiki';
import type { Highlighter } from 'shiki';
import { createHash } from 'node:crypto';
import { registerMathRules, registerMathRenderers } from '$shared/markdown-math';

// 双主题：一份 HTML 携带两套取色变量，data-theme 切换纯 CSS，RENDER_CACHE 不受影响
const THEMES = { light: 'github-light', dark: 'github-dark' } as const;
const LANGS = [
    'typescript',
    'javascript',
    'tsx',
    'jsx',
    'python',
    'go',
    'rust',
    'bash',
    'sql',
    'json',
    'jsonc',
    'yaml',
    'html',
    'css',
    'scss',
    'less',
    'markdown',
    'docker',
    'diff',
    'toml',
    'ini',
    'xml',
    'c',
    'cpp',
    'csharp',
    'java',
    'kotlin',
    'swift',
    'php',
    'ruby',
    'graphql',
    'vue',
    'svelte',
    'powershell',
    'bat',
    'nginx',
    'makefile',
    'console',
    'latex'
];

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
    if (!highlighterPromise) {
        highlighterPromise = createHighlighter({ langs: LANGS, themes: [THEMES.light, THEMES.dark] }).catch(
            (e) => {
                highlighterPromise = null;
                throw e;
            }
        );
    }
    return highlighterPromise;
}

// M13: MarkdownIt 实例 + math 规则只构建一次（原来每次渲染都 new + 重注册），shiki highlighter 已单例。
let mdInstance: MarkdownIt | null = null;

async function getMarkdown(): Promise<MarkdownIt> {
    if (mdInstance) return mdInstance;
    const hl = await getHighlighter();
    const md = new MarkdownIt({
        html: false,
        linkify: true,
        typographer: true,
        highlight: (code, lang) => {
            if (lang === 'mermaid') return '';
            const isAscii = !lang || lang === 'text';
            const kind = isAscii ? 'ascii' : 'prose';
            const stamp = (html: string) => html.replace(/<pre\b/, `<pre data-rr-code="${kind}"`);
            // dual themes + defaultColor:false：token 输出 --shiki-light/--shiki-dark 变量（无内联默认色/背景），
            // 取色与背景由 styles/theme.css 按 data-theme 控制（Task 5 接线）
            const dual = {
                themes: { light: THEMES.light, dark: THEMES.dark },
                defaultColor: false
            } as const;
            try {
                return stamp(hl.codeToHtml(code, { lang: lang || 'text', ...dual }));
            } catch (e) {
                console.error('[markdown] shiki highlight failed for lang', lang, e);
                // 未预载语言：用 text 重渲染，保证与正常代码块一致的双主题外观
                try {
                    return stamp(hl.codeToHtml(code, { lang: 'text', ...dual }));
                } catch {
                    const esc = code.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
                    return `<pre data-rr-code="${kind}" class="shiki" style="color:var(--shiki-light);--shiki-dark:#e1e4e8"><code>${esc}</code></pre>`;
                }
            }
        }
    });
    registerMathRules(md);
    registerMathRenderers(md);
    md.renderer.rules.table_open = () => '<div class="rr-table-outer"><div class="rr-table-wrap"><table>';
    md.renderer.rules.table_close = () => '</table></div></div>';
    mdInstance = md;
    return md;
}

// M13: 渲染结果按内容 hash 缓存（热文档重复访问跳过渲染）。FIFO 上限防无界增长。
const RENDER_CACHE = new Map<string, string>();
const RENDER_CACHE_MAX = 128;

export async function renderMarkdown(src: string): Promise<string> {
    const md = await getMarkdown();
    const key = createHash('sha256').update(src, 'utf8').digest('hex');
    const hit = RENDER_CACHE.get(key);
    if (hit !== undefined) return hit;
    const html = md.render(src);
    if (RENDER_CACHE.size >= RENDER_CACHE_MAX) {
        const first = RENDER_CACHE.keys().next().value;
        if (first !== undefined) RENDER_CACHE.delete(first);
    }
    RENDER_CACHE.set(key, html);
    return html;
}

// 仅供测试：清空缓存与单例，验证缓存命中/重建逻辑
export function __resetMarkdownCacheForTest(): void {
    mdInstance = null;
    RENDER_CACHE.clear();
}
