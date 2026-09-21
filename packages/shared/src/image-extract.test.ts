import { describe, it, expect } from 'vitest';
import { extractImageNames, normalizeImageRef, imageTokenLines, extractLocalImageSrcs } from './image-extract';

describe('extractImageNames（裸名提取单源）', () => {
    it('本地裸名提取', () => {
        expect(extractImageNames('![a](shot.png)')).toEqual(['shot.png']);
    });
    it('带 ./ 前缀与 query/fragment 剥离 + URL decode', () => {
        expect(extractImageNames('![a](./my%20shot.png?w=100#x)')).toEqual(['my shot.png']);
    });
    it('外链/data:/站内绝对路径不提取', () => {
        expect(extractImageNames('![a](https://x.com/a.png)![b](data:image/png;base64,xx)![c](/abs.png)')).toEqual([]);
    });
    it('引用式图片语法同样提取', () => {
        expect(extractImageNames('![a][r]\n\n[r]: logo.png')).toEqual(['logo.png']);
    });
    it('code block / inline code 内不提取', () => {
        expect(extractImageNames('```\n![a](x.png)\n```\n`![b](y.png)`')).toEqual([]);
    });
    it('math 内的图片语法不提取（与 web 渲染实例同构，P1-3 语义差锁定）', () => {
        expect(extractImageNames('$![x](y.png)$')).toEqual([]);
    });
    it('含路径分隔符的 src 不提取（仅裸名匹配 owner 池，spec #20）', () => {
        expect(extractImageNames('![a](sub/dir/x.png)')).toEqual([]);
    });
    it('重复引用去重保序', () => {
        expect(extractImageNames('![a](x.png)![b](x.png)![c](y.png)')).toEqual(['x.png', 'y.png']);
    });
});

describe('normalizeImageRef（归一化单源——渲染 renderer 与提取器共用）', () => {
    it('裸名原样', () => { expect(normalizeImageRef('shot.png')).toBe('shot.png'); });
    it('./ 前缀剥离 + query/fragment 剥离 + decode', () => {
        expect(normalizeImageRef('./my%20shot.png?w=1#x')).toBe('my shot.png');
    });
    it('外链/站内绝对/data: → null（渲染原样输出的判定）', () => {
        expect(normalizeImageRef('https://x.com/a.png')).toBeNull();
        expect(normalizeImageRef('/abs.png')).toBeNull();
        expect(normalizeImageRef('data:image/png;base64,x')).toBeNull();
    });
    it('含路径分隔符 → null', () => { expect(normalizeImageRef('sub/dir.png')).toBeNull(); });
    it('非法百分号编码 → 原样返回（不炸）', () => { expect(normalizeImageRef('a%zz.png')).toBe('a%zz.png'); });
});

describe('imageTokenLines / extractLocalImageSrcs（桥编排单源）', () => {
    it('返回 token 级 {src, line}——行取父 inline map 范围内含该 src 的行', () => {
        const md = '![a](shot.png)\nsome text\n$![x](y.png)$\n```\n![c](z.png)\n```';
        const toks = imageTokenLines(md);
        expect(toks).toEqual([{ src: 'shot.png', line: 0 }]);
    });
    it('多行段落：图片在非首行 → line 是图片实际所在行（非块首行）', () => {
        const toks = imageTokenLines('l0\n![m](m.png)\nl2');
        expect(toks).toEqual([{ src: 'm.png', line: 1 }]);
    });
    it('原始 src 保留编码形态（normalizeLink 产物——文件系统读取时 decode，改写时用原样）', () => {
        // markdown-it normalizeLink 对空格/CJK 百分号编码；尖括号语法才允许空格
        expect(extractLocalImageSrcs('![a](<./pics/a b.png>)')).toEqual(['./pics/a%20b.png']);
        expect(extractLocalImageSrcs('![截图](截图.png)')).toEqual(['%E6%88%AA%E5%9B%BE.png']);
        // 探针实测（2026-09-21，bun 跑 markdown-it 14.x normalizeLink/mdurl）：query 的 ? 不被编码、原样保留
        expect(extractLocalImageSrcs('![a](a.png?x=1)')).toEqual(['a.png?x=1']);
    });
    it('scheme 过滤（http/data 不进本地列表）+ Windows 盘符例外', () => {
        expect(extractLocalImageSrcs('![a](https://x.com/a.png)![b](data:image/png;base64,x)')).toEqual([]);
        // C:\ / C:/ 是盘符路径不是 scheme（P2-5：否则 Windows 绝对路径静默跳过）
        expect(extractLocalImageSrcs('![a](C:\\Users\\me\\shot.png)')).toEqual(['C:\\Users\\me\\shot.png']);
    });
    it('含分隔符的相对路径保留（本地路径语义——与裸名提取器 extractImageNames 的分工）', () => {
        expect(extractLocalImageSrcs('![a](sub/dir/a.png)')).toEqual(['sub/dir/a.png']);
    });
    it('去重保序', () => {
        expect(extractLocalImageSrcs('![a](x.png)![b](x.png)')).toEqual(['x.png']);
    });
    it('表格内图片：父 inline 无 map → 降级返回该 src 的全部出现行（改写走全文逐行）', () => {
        const md = '| a | b |\n|---|---|\n| ![x](t.png) | y |';
        const toks = imageTokenLines(md);
        expect(toks.length).toBe(1);
        expect(toks[0].src).toBe('t.png');
        // line 为图片实际行（实现：表格内 inline.map=null → 扫描含 src 的行取首个；改写安全由 split/join 天然保证）
        expect(toks[0].line).toBe(2);
    });
    it('行定位双形态匹配（Task 1 遗留边界）：md 原文写中文、token src 是编码形态 → 行不丢', () => {
        // lineOf 用编码形态 includes 匹配 md 原文会 miss → line=-1 → 改写丢失；decode 形态也须命中
        expect(imageTokenLines('![截图](截图.png)')).toEqual([{ src: '%E6%88%AA%E5%9B%BE.png', line: 0 }]);
        // 范围内未命中后的全文兜底同样双形态；空格编码形态同理
        expect(imageTokenLines('![a](<a b.png>)')).toEqual([{ src: 'a%20b.png', line: 0 }]);
    });
});
