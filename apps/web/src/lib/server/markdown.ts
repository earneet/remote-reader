import MarkdownIt from 'markdown-it';
import { createHighlighter } from 'shiki';
import type { Highlighter } from 'shiki';
import { createHash } from 'node:crypto';
import anchor from 'markdown-it-anchor';
import GithubSlugger from 'github-slugger';
import { registerMathRules, registerMathRenderers } from '$shared/markdown-math';
import { extractImageNames, normalizeImageRef } from '@remote-reader/shared/image-extract';

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
    // 标题锚点：GitHub 风格 slug（CJK 保留、标点剥离、空格转连字符）——文档内目录链接与
    // URL #fragment 跳转的着落目标。默认 slugify 保留点号（`5.-标题`），须换 github-slugger
    // 对齐 Agent 写目录的 GitHub 惯例；slugger 实例内部有跨调用去重状态，每标题新建，
    // 去重交回插件（per-render env，-1/-2 后缀与 GitHub 一致），否则第二篇文档的同名标题会漂移
    md.use(anchor, {
        slugify: (s) => new GithubSlugger().slug(s)
    });
    md.renderer.rules.table_open = () => '<div class="rr-table-outer"><div class="rr-table-wrap"><table>';
    md.renderer.rules.table_close = () => '</table></div></div>';
    mdInstance = md;
    return md;
}

// M13: 渲染结果按内容 hash 缓存（热文档重复访问跳过渲染）。FIFO 上限防无界增长。
// RENDER_CACHE value 两段式：渲染阶段产物（占位符 HTML + names + 内容 hash）——替换阶段每请求执行
const RENDER_CACHE = new Map<string, { html: string; names: string[]; contentHash: string }>();
const RENDER_CACHE_MAX = 128;

export async function renderMarkdown(src: string): Promise<{ html: string; names: string[]; contentHash: string }> {
    const contentHash = createHash('sha256').update(src, 'utf8').digest('hex');
    const hit = RENDER_CACHE.get(contentHash);
    if (hit !== undefined) return hit;
    const md = await getMarkdown();
    // names 单源来自 extractImageNames（P1-3）；renderer 的归一化用同一 normalizeImageRef（防索引错位）
    const names = extractImageNames(src);
    const stub = contentHash.slice(0, 8);
    const defaultImage = md.renderer.rules.image; // 保留默认渲染器语义（alt/title/attr 转义由它兜底）
    md.renderer.rules.image = (tokens, idx, options, env, self) => {
        const token = tokens[idx];
        const raw = token.attrGet('src') ?? '';
        const norm = normalizeImageRef(raw);
        if (norm !== null) {
            const n = names.indexOf(norm);
            if (n >= 0) {
                token.attrSet('src', `%%RR:IMG:${stub}:${n}%%`);
                // referrerpolicy 渲染期预置（spec §7.3/§16）：仅裸名图（将占位符化者）。
                // 替换阶段只换 URL 字符串，无法向 <img> 标签追加属性——presign 直连图发 origin 供
                // 七牛 Referer 白名单；代理路径同属性无害（同源请求不受影响）
                token.attrSet('referrerpolicy', 'strict-origin-when-cross-origin');
            }
        }
        token.attrSet('loading', 'lazy');
        token.attrSet('decoding', 'async');
        return defaultImage!(tokens, idx, options, env, self);
    };
    let html: string;
    try {
        html = md.render(src);
    } finally {
        md.renderer.rules.image = defaultImage; // 实例单例——渲染后恢复（占位符 stub 逐次不同）
    }
    const result = { html, names, contentHash };
    if (RENDER_CACHE.size >= RENDER_CACHE_MAX) {
        const first = RENDER_CACHE.keys().next().value;
        if (first !== undefined) RENDER_CACHE.delete(first);
    }
    RENDER_CACHE.set(contentHash, result);
    return result;
}

// 仅供测试：清空缓存与单例，验证缓存命中/重建逻辑
export function __resetMarkdownCacheForTest(): void {
    mdInstance = null;
    RENDER_CACHE.clear();
}
