// lightbox（div role=dialog）键盘焦点圈定：aria-modal 语义要求 Tab 不越出浮层。
// drawer/ActionSheet 用原生 <dialog> 无此问题；两个 div 浮层（mermaid/表格）共用本实现
export function trapTabKey(e: KeyboardEvent, container: HTMLElement): void {
    if (e.key !== 'Tab') return;
    const focusables = container.querySelectorAll<HTMLElement>(
        'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    );
    if (focusables.length === 0) return;
    const first = focusables[0];
    const last = focusables[focusables.length - 1];
    const active = container.ownerDocument.activeElement;
    if (e.shiftKey && (active === first || !container.contains(active))) {
        e.preventDefault();
        last.focus();
    } else if (!e.shiftKey && (active === last || !container.contains(active))) {
        e.preventDefault();
        first.focus();
    }
}
