// 浏览器全屏管理 action（⛶ 切换 + fullscreenchange 状态同步）：
// 从 TableFullscreen / ImageLightbox / MermaidViewer 三份内联实现（已漂移）逐字收敛。
// 语义：class 'rr-fs' 驱动视觉全屏（跨平台——iOS 无 Fullscreen API 也生效，CSS 布局走 class）；
// requestFullscreen 让桌面/Android 隐藏浏览器 UI——旧 WebKit（<16.4）方法存在但返回 undefined，
// 返回值经变量中转再 ?.catch 防 TypeError，失败静默（class 已兜底布局）；
// 浏览器退出全屏（Esc）时 fullscreenchange 移除 class，防「浏览器已退出、class 残留」。
// 组件侧零状态零监听：use:browserFullscreen={ctl} 挂载后经 ctl.toggle()/exit() 驱动。
export type BrowserFullscreenCtl = {
    /** ⛶ 按钮：视觉全屏切换 + 渐进增强真全屏 */
    toggle(): void;
    /** 浮层关闭路径：退出真全屏（若有）+ 清 class */
    exit(): void;
};

export function browserFullscreen(el: HTMLElement, ctl: BrowserFullscreenCtl): { destroy(): void } {
    const setActive = (active: boolean): void => { el.classList.toggle('rr-fs', active); };
    ctl.toggle = (): void => {
        const next = !el.classList.contains('rr-fs');
        setActive(next);
        if (next) {
            const p = el.requestFullscreen?.();
            p?.catch(() => {});
        } else if (document.fullscreenElement) {
            const p2 = document.exitFullscreen?.();
            p2?.catch(() => {});
        }
    };
    ctl.exit = (): void => {
        setActive(false);
        if (document.fullscreenElement) document.exitFullscreen()?.catch(() => {});
    };
    const onFsChange = (): void => {
        if (!document.fullscreenElement) setActive(false);
    };
    document.addEventListener('fullscreenchange', onFsChange);
    return {
        destroy() {
            document.removeEventListener('fullscreenchange', onFsChange);
        }
    };
}
