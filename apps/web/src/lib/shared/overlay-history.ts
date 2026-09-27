// 模态浮层（移动抽屉/ActionSheet）共用的 history 编排：
// 打开时推一条同 URL 浅路由条目（兜系统返回键 = 关浮层而非退出页面），
// 非返回键关闭时须 await popstate 消费完该条目再做后续导航——SvelteKit goto 也 pushState，
// 乱序会把刚推的条目弹掉（mobile-fm spec §6.4）。
import { pushState } from '$app/navigation';
import { page } from '$app/state';

export function popOnce(): Promise<void> {
    return new Promise((resolve) => {
        const once = () => {
            window.removeEventListener('popstate', once);
            resolve();
        };
        window.addEventListener('popstate', once);
        history.back();
    });
}

export interface OverlayHistory {
    /** 打开浮层时调用：推浅路由条目并记为未消费 */
    push(): void;
    /** 关闭浮层时调用：条目尚未被返回键消费则 back 弹掉（幂等，可安全重复调用） */
    consume(): Promise<void>;
    /** 返回键关闭路径调用：popstate 已弹掉条目，仅清除标记（之后 consume 为 no-op） */
    markConsumedByPop(): void;
    readonly isPushed: boolean;
    /**
     * 系统返回键回调：仅当本实例是**栈顶**未消费实例时被通知（LIFO）。
     * 消费方关闭浮层即可（markConsumedByPop 已由派发器完成）——不得再自行 consume。
     * 修复（验收第 2 轮）：此前各浮层自挂全局 popstate 监听、只判自身开闭，分不清弹的是谁的
     * 条目——R-40 使 lightbox 可叠在表格全屏之上后，一次返回会同时误关两层并留死条目
     */
    setOnPop(cb: () => void): void;
}

// 模块级 LIFO 栈 + 单一全局监听：popstate 只派发给栈顶实例（谁的条目被弹只看栈序，
// 与各实例自挂监听的「谁都关」相对）。popOnce 期间实例留在栈顶——consume 诱发的 back
// 弹的正是自己的条目，派发器对其 markConsumedByPop（幂等），下层浮层不受扰
const overlayStack: Array<{ mark: () => void; onPop: (() => void) | null }> = [];
let overlayGlobalListener: (() => void) | null = null;

function ensureOverlayGlobalListener(): void {
    if (overlayGlobalListener) return;
    overlayGlobalListener = () => {
        const top = overlayStack[overlayStack.length - 1];
        if (!top) return;
        top.mark();
        top.onPop?.();
    };
    window.addEventListener('popstate', overlayGlobalListener);
}

export function createOverlayHistory(): OverlayHistory {
    let pushed = false;
    const entry: { mark: () => void; onPop: (() => void) | null } = {
        mark: (): void => {
            pushed = false;
            const i = overlayStack.indexOf(entry);
            if (i >= 0) overlayStack.splice(i, 1);
        },
        onPop: null
    };
    return {
        push(): void {
            pushState(page.url, { rrOverlay: true });
            pushed = true;
            ensureOverlayGlobalListener();
            overlayStack.push(entry);
        },
        async consume(): Promise<void> {
            if (!pushed) return;
            pushed = false;
            await popOnce();
            const i = overlayStack.indexOf(entry);
            if (i >= 0) overlayStack.splice(i, 1);
        },
        markConsumedByPop(): void {
            entry.mark();
        },
        setOnPop(cb: () => void): void {
            entry.onPop = cb;
        },
        get isPushed(): boolean {
            return pushed;
        }
    };
}
