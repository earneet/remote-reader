import { test, expect, describe, it } from 'vitest';
import { renderMarkdown, __resetMarkdownCacheForTest } from '../src/lib/server/markdown';

test('渲染标题', async () => {
    const html = (await renderMarkdown('# Title')).html;
    expect(html).toContain('<h1 id="title" tabindex="-1">Title</h1>');
});

// ===== 标题锚点（heading id，GitHub 风格 slug——救活文档目录链接与 #fragment 跳转）=====

test('CJK 标题生成 GitHub 风格 id（CJK 保留、标点剥离、空格转连字符）', async () => {
    const html = (await renderMarkdown('## 5. 边界情况分析')).html;
    expect(html).toContain('<h2 id="5-边界情况分析" tabindex="-1">');
});

test('英文标题 slug 小写化 + 空格转连字符', async () => {
    const html = (await renderMarkdown('## Hello World')).html;
    expect(html).toContain('<h2 id="hello-world" tabindex="-1">');
});

test('重复标题加数字后缀去重（GitHub 同款 -1）', async () => {
    const html = (await renderMarkdown('## 重复\n\n## 重复')).html;
    expect(html).toContain('id="重复"');
    expect(html).toContain('id="重复-1"');
});

test('标题内行内代码文本计入 slug（GitHub 对齐）', async () => {
    const html = (await renderMarkdown('## Use `npm install` now')).html;
    expect(html).toContain('id="use-npm-install-now"');
});

test('渲染段落与加粗', async () => {
    const html = (await renderMarkdown('这是一份 **测试** 文档。')).html;
    expect(html).toContain('<strong>测试</strong>');
});

test('渲染表格（GFM）', async () => {
    const html = (await renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')).html;
    expect(html).toContain('<table>');
});

test('默认不渲染原始 HTML（XSS 防护）', async () => {
    const html = (await renderMarkdown('<script>alert(1)</script>')).html;
    expect(html).not.toContain('<script>');
});

test('代码块带 shiki 高亮', async () => {
    const html = (await renderMarkdown('```ts\nconst x: number = 1;\n```')).html;
    expect(html).toContain('shiki');
});

test('常用语言有 shiki 双主题着色（--shiki-light/--shiki-dark 变量输出）', async () => {
    const tsx = (await renderMarkdown('```tsx\nconst App = () => <div/>;\n```')).html;
    expect(tsx).toContain('shiki');
    expect(tsx).toContain('--shiki-light');
    expect(tsx).toContain('--shiki-dark');
    const cpp = (await renderMarkdown('```cpp\nint main(){return 0;}\n```')).html;
    expect(cpp).toContain('shiki');
    expect(cpp).toContain('--shiki-light');
    expect(cpp).toContain('--shiki-dark');
});

test('未预载语言安全降级为双主题代码块（不抛错、内容不丢失、带 shiki 外观）', async () => {
    const html = (await renderMarkdown('```brainfuck\n++++++++[>++++++++<-]>\n```')).html;
    expect(html).toContain('shiki');
    expect(html).toContain('--shiki-dark');
    expect(html).toContain('shiki-themes');
    expect(html).toContain('++++++++');
});

test('代码块按语言标记分流：无语言=text 标 ascii（CJK 等宽对齐），有语言标 prose（西文等宽）', async () => {
    const ascii = (await renderMarkdown('```\n┌───┐\n│ A │\n└───┘\n```')).html;
    expect(ascii).toContain('data-rr-code="ascii"');
    const text = (await renderMarkdown('```text\nplain\n```')).html;
    expect(text).toContain('data-rr-code="ascii"');
    const prose = (await renderMarkdown('```ts\nconst x = 1;\n```')).html;
    expect(prose).toContain('data-rr-code="prose"');
});

test('mermaid fence 输出 language-mermaid class 供客户端识别', async () => {
    const html = (await renderMarkdown('```mermaid\ngraph TD; A-->B\n```')).html;
    expect(html).toContain('language-mermaid');
});

test('inline $...$ 转为 math inline 占位 span', async () => {
    const html = (await renderMarkdown('公式 $a+b$ 末尾')).html;
    expect(html).toContain('class="math inline"');
    expect(html).toContain('a+b');
});

test('block $$...$$ 转为 math block 占位 div', async () => {
    const html = (await renderMarkdown('$$\nx = y\n$$')).html;
    expect(html).toContain('class="math block"');
    expect(html).toContain('x = y');
});

test('渲染结果缓存：同输入返回同输出、不同输入各异（M13）', async () => {
    __resetMarkdownCacheForTest();
    // 命中直返缓存对象（markdown.ts RENDER_CACHE 命中分支 return hit）——对象级 toBe
    // 才能区分「命中」与「重新渲染出相同结果」（字符串值比较在渲染确定性下恒真）
    const o1 = await renderMarkdown('# cached');
    const o2 = await renderMarkdown('# cached');
    expect(o2).toBe(o1);
    expect(o1.html).toContain('cached');
    const b = await renderMarkdown('# other');
    expect(b).not.toBe(o1);
});

test('表格被 overflow 壳包裹（防手机撑破布局）', async () => {
    const html = (await renderMarkdown('| a | b |\n|---|---|\n| 1 | 2 |')).html;
    expect(html).toContain('<div class="rr-table-wrap">');
    expect(html).toContain('</table></div>');
    expect(html).toContain('<table>');
});

// ===== math 解析器边界（cycle2 审查）=====

test('货币写法 $5 和 $10 不误判为行内公式（首尾空白防护）', async () => {
    const html = (await renderMarkdown('价格 $5 和 $10 总计')).html;
    expect(html).not.toContain('class="math inline"');
});

test('紧邻正文的 $$ 公式块也渲染（段落中断，无空行分隔）', async () => {
    const html = (await renderMarkdown('前文段落\n$$\nx = y\n$$')).html;
    expect(html).toContain('class="math block"');
    expect(html).toContain('x = y');
});

test('$$ 同行尾随内容并入公式体不丢弃', async () => {
    const html = (await renderMarkdown('$$ E=mc^2\n$$')).html;
    expect(html).toContain('class="math block"');
    expect(html).toContain('E=mc^2');
});

test('未闭合 $$ 按普通文本回落，不吞后续内容', async () => {
    const html = (await renderMarkdown('$$\n没有闭合的公式\n\n后面段落')).html;
    expect(html).not.toContain('class="math block"');
    expect(html).toContain('后面段落');
});

test('连续单行 $$..$$ 公式各自独立渲染（同行自闭合，不吞相邻公式）', async () => {
    const html = (await renderMarkdown('$$ a^2+b^2=c^2 $$\n$$ d^2+e^2=f^2 $$')).html;
    const blocks = html.match(/class="math block"/g) ?? [];
    expect(blocks.length).toBe(2);
    expect(html).toContain('a^2+b^2=c^2');
    expect(html).toContain('d^2+e^2=f^2');
    // 公式体不得混入尾随 $$ 定界符
    expect(html).not.toContain('c^2 $$');
});

test('单个单行 $$ 公式渲染为 block 而非裸 $ 剥壳的 inline', async () => {
    const html = (await renderMarkdown('$$\\alpha$$')).html;
    expect(html).toContain('class="math block"');
    expect(html).toContain('\\alpha');
    expect(html).not.toContain('class="math inline"');
});

test('行尾带尾随文本的 $$..$$ 按字面回落，不被 inline 剥壳成 $公式$', async () => {
    const html = (await renderMarkdown('$$\\alpha$$ 后续段落')).html;
    expect(html).not.toContain('class="math inline"');
    expect(html).toContain('$$'); // 定界符字面保留（display 公式不支持同行尾随文本）
});

describe('渲染管线两段式（占位符阶段）', () => {
    it('裸名图片输出占位符 src（含内容 hash 前 8 + 索引）+ lazy/decoding', async () => {
        const r = await renderMarkdown('![a](shot.png)');
        expect(r.names).toEqual(['shot.png']);
        expect(r.html).toMatch(/<img src="%%RR:IMG:[0-9a-f]{8}:0%%"[^>]*loading="lazy"[^>]*decoding="async"/);
        expect(r.contentHash).toMatch(/^[0-9a-f]{64}$/);
    });
    it('外链/data:/绝对路径/含分隔符 src 原样输出（不占位）', async () => {
        const r = await renderMarkdown('![a](https://x.com/a.png)![b](data:image/png;base64,x)![c](sub/d.png)');
        expect(r.html).toContain('src="https://x.com/a.png"');
        expect(r.html).toContain('src="data:image/png;base64,x"');
        expect(r.html).toContain('src="sub/d.png"');
        expect(r.names).toEqual([]);
    });
    it('math 吞图锁定（P1-3 第三消费方）：$...$ 内图片不提取不占位', async () => {
        const r = await renderMarkdown('$![a](x.png)$');
        expect(r.names).toEqual([]);
        expect(r.html).not.toContain('%%RR:IMG');
    });
    it('重复引用同图共用索引（names 去重保序一致）', async () => {
        const r = await renderMarkdown('![a](x.png)![b](x.png)');
        expect(r.html.match(/%%RR:IMG:[0-9a-f]{8}:0%%/g)?.length).toBe(2);
    });
    it('alt 转义保留', async () => {
        const r = await renderMarkdown('![<b>alt</b>](x.png)');
        expect(r.html).toContain('alt="&lt;b&gt;alt&lt;/b&gt;"');
    });
    it('缓存命中返回同构结果（value 结构 {html,names,contentHash}）', async () => {
        const a = await renderMarkdown('# t ![x](a.png)');
        const b = await renderMarkdown('# t ![x](a.png)');
        expect(b).toEqual(a); // 结构完整性（缓存命中行为由既有缓存用例覆盖）
    });
});
