// overlay-history 栈化（验收第 2 轮 P2 修复）的回归测试锁：
// LIFO 派发（叠开一次返回只关顶层）、✕ 关不级联、consume/mark 双向幂等、legacy 双调无害。
// $app/navigation 与 $app/state 经 vitest alias 解析到 tests/stubs/ 桩；window/history 以最小假体注入。
import { test, expect, beforeEach, vi } from 'vitest';
import { createOverlayHistory } from '../src/lib/shared/overlay-history';

type Listener = (e: Event) => void;
const listeners = new Set<Listener>();
const firePop = (): void => {
    for (const l of [...listeners]) l(new Event('popstate'));
};
const backMock = vi.fn(() => firePop());

vi.stubGlobal('window', {
    addEventListener: (_t: string, l: Listener) => { listeners.add(l); },
    removeEventListener: (_t: string, l: Listener) => { listeners.delete(l); }
});
vi.stubGlobal('history', { back: backMock });

function mkInstance(): { h: ReturnType<typeof createOverlayHistory>; onPop: ReturnType<typeof vi.fn> } {
    const h = createOverlayHistory();
    const onPop = vi.fn();
    h.setOnPop(onPop);
    return { h, onPop };
}

beforeEach(() => {
    backMock.mockClear();
});

test('叠开一次返回只关顶层（LIFO 派发核心场景）', () => {
    const a = mkInstance();
    const b = mkInstance();
    a.h.push();
    b.h.push();
    firePop();
    expect(b.onPop).toHaveBeenCalledTimes(1);
    expect(a.onPop).not.toHaveBeenCalled();
    expect(b.h.isPushed).toBe(false);
    expect(a.h.isPushed).toBe(true); // 下层存活——此前自挂监听版本会误关两层
    // 收尾清栈：再返回关下层
    firePop();
    expect(a.onPop).toHaveBeenCalledTimes(1);
});

test('✕ 关顶层不级联：consume 诱发的 back 只派发自己', async () => {
    const a = mkInstance();
    const b = mkInstance();
    a.h.push();
    b.h.push();
    b.onPop.mockClear();
    await b.h.consume();
    expect(backMock).toHaveBeenCalledTimes(1);
    expect(b.onPop).toHaveBeenCalledTimes(1); // consume 期间的派发（幂等关闭）
    expect(a.onPop).not.toHaveBeenCalled(); // 下层不受扰
    expect(a.h.isPushed).toBe(true);
    await a.h.consume();
    expect(backMock).toHaveBeenCalledTimes(2);
});

test('返回键关闭后 consume 为 no-op（不产生多余 back）', async () => {
    const a = mkInstance();
    a.h.push();
    firePop();
    expect(a.onPop).toHaveBeenCalledTimes(1);
    await a.h.consume();
    expect(backMock).not.toHaveBeenCalled();
});

test('markConsumedByPop 双调幂等（legacy 组件自挂监听与全局派发器并存）', async () => {
    const a = mkInstance();
    a.h.push();
    // legacy ActionSheet/抽屉路径：自身监听先 mark，全局派发器随后再次 mark
    a.h.markConsumedByPop();
    a.h.markConsumedByPop();
    expect(a.h.isPushed).toBe(false);
    await a.h.consume();
    expect(backMock).not.toHaveBeenCalled();
});

test('栈清空后 popstate 无派发（无泄漏残留实例）', async () => {
    const a = mkInstance();
    const b = mkInstance();
    a.h.push();
    b.h.push();
    await b.h.consume();
    await a.h.consume();
    a.onPop.mockClear();
    b.onPop.mockClear();
    const c = mkInstance(); // 栈已空，新实例未 push
    firePop();
    expect(c.onPop).not.toHaveBeenCalled();
    expect(a.onPop).not.toHaveBeenCalled();
    expect(b.onPop).not.toHaveBeenCalled();
});

test('未 push 的实例 consume 直接返回', async () => {
    const a = mkInstance();
    await a.h.consume();
    expect(backMock).not.toHaveBeenCalled();
});
