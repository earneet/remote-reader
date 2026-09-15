// 行内编辑表单的安全聚焦+全选（use: action 仅客户端挂载时执行，SSR 无真实 DOM）
export function autofocus(node: HTMLInputElement) {
    node.focus();
    node.select();
}
