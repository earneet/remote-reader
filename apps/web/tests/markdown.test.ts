import { test, expect } from 'vitest';
import { renderMarkdown, __resetMarkdownCacheForTest } from '../src/lib/server/markdown';

test('渲染标题', async () => {
    const html = await renderMarkdown('# Title');
    expect(html).toContain('<h1>Title</h1>');
});

test('渲染段落与加粗', async () => {
    const html = await renderMarkdown('这是一份 **测试** 文档。');
    expect(html).toContain('<strong>测试</strong>');
});

test('渲染表格（GFM）', async () => {
    const html = await renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<table>');
});

test('默认不渲染原始 HTML（XSS 防护）', async () => {
    const html = await renderMarkdown('<script>alert(1)</script>');
    expect(html).not.toContain('<script>');
});

test('代码块带 shiki 高亮', async () => {
    const html = await renderMarkdown('```ts\nconst x: number = 1;\n```');
    expect(html).toContain('shiki');
});

test('常用语言有 shiki 双主题着色（--shiki-light/--shiki-dark 变量输出）', async () => {
    const tsx = await renderMarkdown('```tsx\nconst App = () => <div/>;\n```');
    expect(tsx).toContain('shiki');
    expect(tsx).toContain('--shiki-light');
    expect(tsx).toContain('--shiki-dark');
    const cpp = await renderMarkdown('```cpp\nint main(){return 0;}\n```');
    expect(cpp).toContain('shiki');
    expect(cpp).toContain('--shiki-light');
    expect(cpp).toContain('--shiki-dark');
});

test('未预载语言安全降级为双主题代码块（不抛错、内容不丢失、带 shiki 外观）', async () => {
    const html = await renderMarkdown('```brainfuck\n++++++++[>++++++++<-]>\n```');
    expect(html).toContain('shiki');
    expect(html).toContain('--shiki-dark');
    expect(html).toContain('shiki-themes');
    expect(html).toContain('++++++++');
});

test('代码块按语言标记分流：无语言=text 标 ascii（CJK 等宽对齐），有语言标 prose（西文等宽）', async () => {
    const ascii = await renderMarkdown('```\n┌───┐\n│ A │\n└───┘\n```');
    expect(ascii).toContain('data-rr-code="ascii"');
    const text = await renderMarkdown('```text\nplain\n```');
    expect(text).toContain('data-rr-code="ascii"');
    const prose = await renderMarkdown('```ts\nconst x = 1;\n```');
    expect(prose).toContain('data-rr-code="prose"');
});

test('mermaid fence 输出 language-mermaid class 供客户端识别', async () => {
    const html = await renderMarkdown('```mermaid\ngraph TD; A-->B\n```');
    expect(html).toContain('language-mermaid');
});

test('inline $...$ 转为 math inline 占位 span', async () => {
    const html = await renderMarkdown('公式 $a+b$ 末尾');
    expect(html).toContain('class="math inline"');
    expect(html).toContain('a+b');
});

test('block $$...$$ 转为 math block 占位 div', async () => {
    const html = await renderMarkdown('$$\nx = y\n$$');
    expect(html).toContain('class="math block"');
    expect(html).toContain('x = y');
});

test('渲染结果缓存：同输入返回同输出、不同输入各异（M13）', async () => {
    __resetMarkdownCacheForTest();
    const a1 = await renderMarkdown('# cached');
    const a2 = await renderMarkdown('# cached');
    expect(a1).toBe(a2);
    const b = await renderMarkdown('# other');
    expect(b).not.toBe(a1);
});

test('表格被 overflow 壳包裹（防手机撑破布局）', async () => {
    const html = await renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |');
    expect(html).toContain('<div class="rr-table-wrap">');
    expect(html).toContain('</table></div>');
    expect(html).toContain('<table>');
});

// ===== math 解析器边界（cycle2 审查）=====

test('货币写法 $5 和 $10 不误判为行内公式（首尾空白防护）', async () => {
    const html = await renderMarkdown('价格 $5 和 $10 总计');
    expect(html).not.toContain('class="math inline"');
});

test('紧邻正文的 $$ 公式块也渲染（段落中断，无空行分隔）', async () => {
    const html = await renderMarkdown('前文段落\n$$\nx = y\n$$');
    expect(html).toContain('class="math block"');
    expect(html).toContain('x = y');
});

test('$$ 同行尾随内容并入公式体不丢弃', async () => {
    const html = await renderMarkdown('$$ E=mc^2\n$$');
    expect(html).toContain('class="math block"');
    expect(html).toContain('E=mc^2');
});

test('未闭合 $$ 按普通文本回落，不吞后续内容', async () => {
    const html = await renderMarkdown('$$\n没有闭合的公式\n\n后面段落');
    expect(html).not.toContain('class="math block"');
    expect(html).toContain('后面段落');
});
