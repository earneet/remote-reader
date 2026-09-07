import { test, expect } from 'vitest';
import { ancestorsOf, visibleNodes, type TreeFolder } from '../src/lib/shared/folder-tree';

function f(id: string, parentId: string | null, childFolders = 0, childFiles = 0): TreeFolder {
    return { id, name: id, parentId, childFolders, childFiles };
}

// 树形：a(根) → b → c → d；e(根，独立)
function fixture(): TreeFolder[] {
    return [
        f('a', null, 1, 0),
        f('b', 'a', 1, 0),
        f('c', 'b', 1, 1),
        f('d', 'c', 0, 2),
        f('e', null, 0, 3)
    ];
}

test('ancestorsOf 返回自顶向下祖先链（不含自身）', () => {
    expect(ancestorsOf(fixture(), 'd')).toEqual(['a', 'b', 'c']);
    expect(ancestorsOf(fixture(), 'b')).toEqual(['a']);
});

test('ancestorsOf 顶层节点返回空数组', () => {
    expect(ancestorsOf(fixture(), 'a')).toEqual([]);
});

test('ancestorsOf 不存在的 id 返回空数组', () => {
    expect(ancestorsOf(fixture(), 'nope')).toEqual([]);
});

test('ancestorsOf parentId 环（脏数据）不死循环', () => {
    const cyc = [
        f('x', 'y'),
        f('y', 'x'),
        f('child', 'x')
    ];
    expect(() => ancestorsOf(cyc, 'child')).not.toThrow();
    // 深度上限截断后返回（内容不断言，只保证不挂）
});

test('visibleNodes 全折叠：仅顶层可见', () => {
    const out = visibleNodes(fixture(), new Set());
    expect(out.map(n => n.id)).toEqual(['a', 'e']);
});

test('visibleNodes 展开 a：a 的孩子可见、孙不可见', () => {
    const out = visibleNodes(fixture(), new Set(['a']));
    expect(out.map(n => n.id)).toEqual(['a', 'b', 'e']);
});

test('visibleNodes 多级全展开：全部可见且 depth 正确', () => {
    const out = visibleNodes(fixture(), new Set(['a', 'b', 'c']));
    expect(out.map(n => n.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(out.map(n => n.depth)).toEqual([0, 1, 2, 3, 0]);
});

test('visibleNodes 孤儿节点（父不在集合）不渲染', () => {
    const orphans = [...fixture(), f('ghost', 'missing-parent')];
    const out = visibleNodes(orphans, new Set(['a', 'b', 'c']));
    expect(out.some(n => n.id === 'ghost')).toBe(false);
});

test('visibleNodes 展开集含已删 id（脏 localStorage）无影响', () => {
    const out = visibleNodes(fixture(), new Set(['deleted-id']));
    expect(out.map(n => n.id)).toEqual(['a', 'e']);
});

test('visibleNodes 保留子项计数字段', () => {
    const out = visibleNodes(fixture(), new Set());
    const d = out.find(n => n.id === 'e');
    expect(d?.childFiles).toBe(3);
});
