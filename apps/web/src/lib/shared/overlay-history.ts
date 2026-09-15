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
}

export function createOverlayHistory(): OverlayHistory {
    let pushed = false;
    return {
        push(): void {
            pushState(page.url, { rrOverlay: true });
            pushed = true;
        },
        async consume(): Promise<void> {
            if (!pushed) return;
            pushed = false;
            await popOnce();
        },
        markConsumedByPop(): void {
            pushed = false;
        },
        get isPushed(): boolean {
            return pushed;
        }
    };
}
