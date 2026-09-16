// FM 行菜单项构造（spec 2026-09-16 §5.6）：目录视图与 RecentList 共用单源——
// 两端同构由构造保证，新增/调整菜单项只改这里（评审跟进：原先两份拷贝已收敛）
export type RowMenuAction = { key: string; label: string; danger?: boolean };

export function rowActions(item: { type: string; shared: boolean }): RowMenuAction[] {
    return [
        { key: 'rename', label: '重命名' },
        ...(item.type === 'file' ? [{ key: 'tags', label: '编辑标签' }] : []),
        { key: 'move', label: '移动到…' },
        ...(item.type === 'file' ? [
            { key: 'share', label: '复制分享链接' },
            ...(item.shared ? [{ key: 'unshare', label: '转为私有', danger: true }] : [])
        ] : []),
        { key: 'delete', label: '删除', danger: true }
    ];
}
