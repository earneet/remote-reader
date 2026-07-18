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
        highlighterPromise = createHighlighter({ langs: LANGS, themes: [THEME] });
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
            try {
                return hl.codeToHtml(code, { lang: lang || 'text', theme: THEME });
            } catch {
                return '';
            }
        }
    });
    return md.render(src);
}
