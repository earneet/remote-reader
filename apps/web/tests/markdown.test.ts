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

test('未预载语言的代码块安全降级（不抛错、内容不丢失）', async () => {
    const html = await renderMarkdown('```brainfuck\n++++++++[>++++++++<-]>\n```');
    expect(html).toContain('<pre>');
    expect(html).toContain('++++++++');
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
