import { test, expect } from 'vitest';
import { ancestorsOf, visibleNodes, folderNamesOf, type TreeFolder } from '../src/lib/shared/folder-tree';

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
    const e = out.find(n => n.id === 'e');
    expect(e?.childFiles).toBe(3);
});

test('visibleNodes 同父兄弟保持输入顺序（非名字序）', () => {
    const fam = [
        f('a', null, 1, 0),
        f('z', 'a'),
        f('y', 'a')
    ];
    const out = visibleNodes(fam, new Set(['a']));
    expect(out.map(n => n.id)).toEqual(['a', 'z', 'y']); // z 先于 y：输入序，非字母序
});

// ===== folderNamesOf（「最近文档」面包屑，spec §6.4） =====

test('folderNamesOf 返回自顶向下路径名链（含 parentId 指向的文件夹）', () => {
    const byId = new Map(fixture().map((x) => [x.id, x]));
    expect(folderNamesOf(byId, 'c')).toEqual(['a', 'b', 'c']); // d 的面包屑
    expect(folderNamesOf(byId, 'a')).toEqual(['a']);           // b 的面包屑
});

test('folderNamesOf null 父 → 空链（根目录文档）', () => {
    expect(folderNamesOf(new Map(), null)).toEqual([]);
});

test('folderNamesOf 父缺失即止（脏数据安全）', () => {
    const byId = new Map([f('orphan', 'missing')].map((x) => [x.id, x]));
    expect(folderNamesOf(byId, 'orphan')).toEqual(['orphan']);
    expect(folderNamesOf(byId, 'missing')).toEqual([]);
});

test('folderNamesOf parentId 环不死循环', () => {
    const cyc = new Map([f('x', 'y'), f('y', 'x')].map((x) => [x.id, x]));
    expect(() => folderNamesOf(cyc, 'x')).not.toThrow();
});
