import { describe, it, expect } from 'vitest';
import { extractImageNames } from './image-extract';

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
