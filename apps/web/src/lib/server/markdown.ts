import MarkdownIt from 'markdown-it';
import { createHighlighter } from 'shiki';
import type { Highlighter } from 'shiki';
import { createHash } from 'node:crypto';

const THEME = 'github-dark';
const LANGS = [
    'typescript',
    'javascript',
    'python',
    'go',
    'rust',
    'bash',
    'sql',
    'json',
    'yaml',
    'html',
    'css',
    'markdown',
    'docker',
    'diff',
    'toml'
];

let highlighterPromise: Promise<Highlighter> | null = null;

function getHighlighter(): Promise<Highlighter> {
    if (!highlighterPromise) {
        highlighterPromise = createHighlighter({ langs: LANGS, themes: [THEME] }).catch(
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
            try {
                return hl.codeToHtml(code, { lang: lang || 'text', theme: THEME });
            } catch (e) {
                console.error('[markdown] shiki highlight failed for lang', lang, e);
                return '';
            }
        }
    });
    md.inline.ruler.before('escape', 'math_inline', (state: any, silent: boolean) => {
        if (state.src[state.pos] !== '$') return false;
        if (state.src[state.pos - 1] === '\\') return false;
        const close = state.src.indexOf('$', state.pos + 1);
        if (close === -1 || close === state.pos + 1) return false;
        const content = state.src.slice(state.pos + 1, close);
        if (content.includes('\n')) return false;
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
            if (silent) return true;
            let nextLine = startLine;
            while (nextLine < endLine) {
                nextLine++;
                const pos = state.bMarks[nextLine] + state.tShift[nextLine];
                if (state.src.slice(pos, pos + 2) === '$$') break;
            }
            if (nextLine >= endLine) return false;
            const contentStart = state.bMarks[startLine + 1];
            const contentEnd = state.eMarks[nextLine - 1];
            const tok = state.push('math_block', 'div', 0);
            tok.block = true;
            tok.markup = '$$';
            tok.content = state.src.slice(contentStart, contentEnd).trim();
            tok.map = [startLine, nextLine];
            state.line = nextLine + 1;
            return true;
        }
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
