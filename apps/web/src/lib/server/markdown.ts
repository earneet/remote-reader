import MarkdownIt from 'markdown-it';
import { createHighlighter } from 'shiki';
import type { Highlighter } from 'shiki';

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

export async function renderMarkdown(src: string): Promise<string> {
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
    return md.render(src);
}
