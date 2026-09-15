import MarkdownIt from 'markdown-it';
import { createHighlighter } from 'shiki';
import type { Highlighter } from 'shiki';
import { createHash } from 'node:crypto';

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
    md.inline.ruler.before('escape', 'math_inline', (state: any, silent: boolean) => {
        if (state.src[state.pos] !== '$') return false;
        // 前一字符是 \（转义）或 $（$$ 序列的内侧——display 定界，行内规则不剥壳，按字面回落）
        if (state.src[state.pos - 1] === '\\' || state.src[state.pos - 1] === '$') return false;
        const close = state.src.indexOf('$', state.pos + 1);
        if (close === -1 || close === state.pos + 1) return false;
        const content = state.src.slice(state.pos + 1, close);
        if (content.includes('\n')) return false;
        // KaTeX 定界符惯例：$...$ 首尾不能是空白——防「价格 $5 和 $10」这类货币写法被误判为公式
        if (/^\s|\s$/.test(content)) return false;
        if (!silent) {
            const tok = state.push('math_inline', 'span', 0);
            tok.markup = '$';
            tok.content = content;
        }
        state.pos = close + 1;
        return true;
    });
    md.block.ruler.before(
        'fence',
        'math_block',
        (state: any, startLine: number, endLine: number, silent: boolean) => {
            const start = state.bMarks[startLine] + state.tShift[startLine];
            if (start + 2 > state.eMarks[startLine]) return false;
            if (state.src.slice(start, start + 2) !== '$$') return false;
            // 同行自闭合 `$$ ... $$`（KaTeX/pandoc 惯例单行 display 公式）：必须在跨行闭合扫描前
            // 判定——否则相邻单行公式的行首 $$ 会被误当闭合定界（吞掉该公式、且公式体混入尾随 $$）
            const selfClosed = state.src.slice(start + 2, state.eMarks[startLine]).match(/^\s*([\s\S]*?)\s*\$\$$/);
            if (selfClosed && selfClosed[1].trim()) {
                if (!silent) {
                    const tok = state.push('math_block', 'div', 0);
                    tok.block = true;
                    tok.markup = '$$';
                    tok.content = selfClosed[1].trim();
                    tok.map = [startLine, startLine + 1];
                    state.line = startLine + 1;
                }
                return true;
            }
            let nextLine = startLine;
            let closed = false;
            while (nextLine < endLine) {
                nextLine++;
                const pos = state.bMarks[nextLine] + state.tShift[nextLine];
                if (state.src.slice(pos, pos + 2) === '$$') { closed = true; break; }
            }
            // 未闭合按普通文本回落（silent 与实际解析判定一致，防段落中断探测误报）
            if (!closed) return false;
            if (silent) return true;
            // $$ 同行尾随内容并入公式体（KaTeX 惯例：`$$ E=mc^2` 不应丢弃 E=mc^2）
            const firstLineRest = state.src.slice(start + 2, state.eMarks[startLine]).trim();
            const midBody = state.src.slice(state.bMarks[startLine + 1], state.eMarks[nextLine - 1]).trim();
            const tok = state.push('math_block', 'div', 0);
            tok.block = true;
            tok.markup = '$$';
            tok.content = firstLineRest && midBody ? `${firstLineRest}\n${midBody}` : (firstLineRest || midBody);
            tok.map = [startLine, nextLine];
            state.line = nextLine + 1;
            return true;
        },
        // 允许中断段落：正文段落直连 $$ 公式块（无空行分隔）也要渲染
        { alt: ['paragraph', 'reference'] }
    );
    md.renderer.rules.math_inline = (tokens: any, idx: number) =>
        `<span class="math inline">${md.utils.escapeHtml(tokens[idx].content)}</span>`;
    md.renderer.rules.math_block = (tokens: any, idx: number) =>
        `<div class="math block">${md.utils.escapeHtml(tokens[idx].content)}</div>\n`;
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
