import { describe, it, expect } from 'vitest';
import MarkdownIt from 'markdown-it';
import { registerMathRules } from './markdown-math';

// 与 web 渲染实例完全同构的配置：math 规则吞掉 $...$ 内的图片语法（P1-3 语义差锁定）
function md(): MarkdownIt {
    const m = new MarkdownIt({ html: false, linkify: true, typographer: true });
    registerMathRules(m);
    return m;
}

describe('markdown-math 共享规则', () => {
    it('$...$ 行内公式渲染为 math span 且不产生 image token', () => {
        const m = md();
        const tokens = m.parse('$![x](y.png)$', {});
        const hasMath = tokens.some((t) => t.children?.some((c) => c.type === 'math_inline'));
        const hasImage = tokens.some((t) => t.children?.some((c) => c.type === 'image'));
        expect(hasMath).toBe(true);
        expect(hasImage).toBe(false);
    });
    it('$$ 块公式同理', () => {
        const m = md();
        const tokens = m.parse('$$\n![x](y.png)\n$$', {});
        expect(tokens.some((t) => t.type === 'math_block')).toBe(true);
        expect(tokens.some((t) => t.children?.some((c) => c.type === 'image'))).toBe(false);
    });
    it('公式外的图片不受影响', () => {
        const m = md();
        const tokens = m.parse('前文 $a$ 然后 ![x](y.png)', {});
        expect(tokens.some((t) => t.children?.some((c) => c.type === 'image'))).toBe(true);
    });
});
