import { test, expect } from 'vitest';
import { renderMarkdown } from '../src/lib/server/markdown';

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

test('未预载语言的代码块安全降级（不抛错）', async () => {
    const html = await renderMarkdown('```brainfuck\n++++++++[>++++++++<-]>\n```');
    expect(html).toContain('<pre>');
});
