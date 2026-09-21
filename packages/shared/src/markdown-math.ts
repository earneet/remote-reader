import type MarkdownIt from 'markdown-it';

// （搬移自 web markdown.ts 2026-09-20 抽取——math_inline/math_block 规则与渲染器）
// P1-3：此文件是 math 规则唯一事实源——web 渲染实例与本包提取器共用，
// 私有副本会造成 token 流漂移（$...$ 吞图语义差 → refs 漂移 → 活图被 GC）。
export function registerMathRules(md: MarkdownIt): void {
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
}

export function registerMathRenderers(md: MarkdownIt): void {
    md.renderer.rules.math_inline = (tokens: any, idx: number) =>
        `<span class="math inline">${md.utils.escapeHtml(tokens[idx].content)}</span>`;
    md.renderer.rules.math_block = (tokens: any, idx: number) =>
        `<div class="math block">${md.utils.escapeHtml(tokens[idx].content)}</div>\n`;
}
