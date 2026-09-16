import { test, expect } from 'vitest';
import { rowActions } from '../src/lib/shared/row-menu';

test('共享文件：6 项且顺序固定（spec 2026-09-16 §5.6）', () => {
    expect(rowActions({ type: 'file', shared: true })).toEqual([
        { key: 'rename', label: '重命名' },
        { key: 'tags', label: '编辑标签' },
        { key: 'move', label: '移动到…' },
        { key: 'share', label: '复制分享链接' },
        { key: 'unshare', label: '转为私有', danger: true },
        { key: 'delete', label: '删除', danger: true }
    ]);
});

test('私有文件：5 项，无「转为私有」，复制分享链接仍在（get-or-create 可建链）', () => {
    const items = rowActions({ type: 'file', shared: false });
    expect(items.map((i) => i.key)).toEqual(['rename', 'tags', 'move', 'share', 'delete']);
    expect(items.some((i) => i.key === 'unshare')).toBe(false);
});

test('文件夹：3 项，无任何分享项', () => {
    const items = rowActions({ type: 'folder', shared: false });
    expect(items.map((i) => i.key)).toEqual(['rename', 'move', 'delete']);
});

test('danger 标记只在 转为私有/删除 上', () => {
    for (const shared of [true, false]) {
        for (const item of rowActions({ type: 'file', shared })) {
            if (item.danger) expect(['unshare', 'delete']).toContain(item.key);
        }
    }
    for (const item of rowActions({ type: 'folder', shared: false })) {
        if (item.danger) expect(item.key).toBe('delete');
    }
});

test('两端同构锁定：菜单项 key 集合与 shared 开关的关系', () => {
    const withShared = rowActions({ type: 'file', shared: true }).map((i) => i.key);
    const without = rowActions({ type: 'file', shared: false }).map((i) => i.key);
    expect(withShared).toEqual([...without.slice(0, 4), 'unshare', ...without.slice(4)]);
});
