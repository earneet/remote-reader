// 模态浮层（抽屉/ActionSheet/lightbox）共用的 body 滚动锁——引用计数。
// 背景（P2-11）：ActionSheet 的 dialog close 事件按规范异步派发，pick() 里 onSelect 先开抽屉、
// 排队的 close 事件随后触发 onDialogClose 把 overflow 清空——单一布尔锁会被后到的关闭误清，
// 只有计数归零才真正解锁
let depth = 0;

export function lockBodyScroll(): void {
    depth++;
    document.body.style.overflow = 'hidden';
}

export function unlockBodyScroll(): void {
    if (depth === 0) return;
    if (--depth === 0) document.body.style.overflow = '';
}

export function __resetBodyScrollForTest(): void {
    depth = 0;
    document.body.style.overflow = '';
}
