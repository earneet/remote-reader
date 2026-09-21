// 浮层挂载 action（聚焦 + body 滚动锁 + 关闭归还焦点）：
// 从 MermaidViewer / TableFullscreen 双份内联实现逐字收敛。
import { lockBodyScroll, unlockBodyScroll } from '$lib/shared/body-scroll';

export function overlayOnMount(node: HTMLElement): { destroy(): void } {
    const prev = document.activeElement as HTMLElement | null;
    node.focus();
    lockBodyScroll();
    return {
        destroy() {
            unlockBodyScroll();
            if (prev && typeof prev.focus === 'function') prev.focus();
        }
    };
}
