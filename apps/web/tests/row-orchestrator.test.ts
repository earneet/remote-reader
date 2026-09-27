import { test, expect, beforeEach, vi } from 'vitest';

// R-06：FM 页与 RecentList 的行操作编排层收敛为单源 RowActionOrchestrator。
// 本文件锁定操作语义（乐观移除/错误反馈/防重/确认门槛）——两端组件漂移（单侧乐观移除）即在此拦截。
const submitAction = vi.fn();
const actionErrorMessageStatus = (status: number): string => `ERR-${status}`;
vi.mock('../src/lib/shared/form-action', () => ({
    submitAction: (...a: unknown[]) => submitAction(...a),
    actionErrorMessage: (status: number) => actionErrorMessageStatus(status)
}));
const fetchShareUrl = vi.fn();
const revokeDocShares = vi.fn();
vi.mock('../src/lib/shared/share-api', () => ({
    fetchShareUrl: (...a: unknown[]) => fetchShareUrl(...a),
    revokeDocShares: (...a: unknown[]) => revokeDocShares(...a)
}));

import { RowActionOrchestrator, type RowCtx } from '../src/lib/shared/row-orchestrator.svelte';

const ctx = (over: Partial<RowCtx> = {}): RowCtx => ({
    id: 'doc1', name: 'a.md', type: 'file', shared: false, tags: [{ id: 't1', name: 'x' }], ...over
});

function mkOrch(over: { isMobile?: boolean } = {}) {
    const refresh = vi.fn();
    const onStartMove = vi.fn();
    const sheet = { show: vi.fn(), hide: vi.fn() };
    const actionMenu = { toggle: vi.fn(), hide: vi.fn() };
    const o = new RowActionOrchestrator({ isMobile: () => over.isMobile ?? false, refresh, onStartMove });
    o.sheet = sheet;
    o.actionMenu = actionMenu;
    return { o, refresh, onStartMove, sheet, actionMenu };
}

beforeEach(() => {
    vi.stubGlobal('confirm', () => true);
    submitAction.mockReset();
    fetchShareUrl.mockReset();
    revokeDocShares.mockReset();
});

test('delete file 成功：乐观移除 + 刷新', async () => {
    const { o, refresh } = mkOrch();
    submitAction.mockResolvedValue(200);
    await o.doDelete('doc1', 'file');
    expect(submitAction).toHaveBeenCalledWith('delete', { id: 'doc1' });
    expect(o.isRemoved('doc1')).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(o.actionError).toBeNull();
    expect(o.busyId).toBeNull();
});

test('delete 404（他方已删）也算成功：移除 + 刷新', async () => {
    const { o, refresh } = mkOrch();
    submitAction.mockResolvedValue(404);
    await o.doDelete('doc1', 'file');
    expect(o.isRemoved('doc1')).toBe(true);
    expect(refresh).toHaveBeenCalledTimes(1);
});

test('delete 失败：actionError 可见、不移除、不刷新', async () => {
    const { o, refresh } = mkOrch();
    submitAction.mockResolvedValue(500);
    await o.doDelete('doc1', 'file');
    expect(o.actionError).toBe('ERR-500');
    expect(o.isRemoved('doc1')).toBe(false);
    expect(refresh).not.toHaveBeenCalled();
});

test('delete 确认取消：不发请求', async () => {
    const { o } = mkOrch();
    vi.stubGlobal('confirm', () => false);
    await o.doDelete('doc1', 'file');
    expect(submitAction).not.toHaveBeenCalled();
    expect(o.isRemoved('doc1')).toBe(false);
});

test('rename 成功：退出编辑态 + 刷新；失败：保持编辑态 + renameError', async () => {
    const { o, refresh } = mkOrch();
    o.startRename(ctx());
    expect(o.editingId).toBe('doc1');
    expect(o.renameValue).toBe('a.md');
    submitAction.mockResolvedValue(200);
    await o.doRename('doc1', 'b.md');
    expect(o.editingId).toBeNull();
    expect(refresh).toHaveBeenCalledTimes(1);
    o.startRename(ctx());
    submitAction.mockResolvedValue(409);
    await o.doRename('doc1', 'c.md');
    expect(o.editingId).toBe('doc1');
    expect(o.renameError).toBe('ERR-409');
});

test('rename 空名守卫：不发请求', async () => {
    const { o } = mkOrch();
    await o.doRename('doc1', '');
    expect(submitAction).not.toHaveBeenCalled();
});

test('setTags 成功：清编辑态与草稿；失败：tagError', async () => {
    const { o } = mkOrch();
    o.startTags(ctx({ tags: [{ id: 't', name: 'v1' }, { id: 't2', name: 'v2' }] }));
    expect(o.tagInput).toBe('v1, v2');
    submitAction.mockResolvedValue(200);
    await o.doSetTags('doc1', 'v1, v3');
    expect(o.taggingId).toBeNull();
    expect(o.tagInput).toBe('');
    submitAction.mockResolvedValue(400);
    o.startTags(ctx());
    await o.doSetTags('doc1', 'x');
    expect(o.tagError).toBe('ERR-400');
});

test('unshare：确认取消不发请求；成功刷新；失败 actionError', async () => {
    const { o, refresh } = mkOrch();
    vi.stubGlobal('confirm', () => false);
    await o.doUnshare('doc1');
    expect(revokeDocShares).not.toHaveBeenCalled();
    vi.stubGlobal('confirm', () => true);
    revokeDocShares.mockResolvedValue(true);
    await o.doUnshare('doc1');
    expect(refresh).toHaveBeenCalledTimes(1);
    revokeDocShares.mockResolvedValue(false);
    await o.doUnshare('doc1');
    expect(o.actionError).toBe('转为私有失败，请重试');
});

test('share：成功刷新 + show 弹层；失败 actionError', async () => {
    const { o, refresh } = mkOrch();
    const show = vi.fn();
    o.shareDialog = { show, hide: vi.fn() };
    fetchShareUrl.mockResolvedValue('/s/xyz');
    await o.doShare('doc1');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(show).toHaveBeenCalledWith('/s/xyz');
    fetchShareUrl.mockResolvedValue(null);
    await o.doShare('doc1');
    expect(o.actionError).toBe('获取分享链接失败，请重试');
});

test('openRowMenu 路由：移动端开 sheet、桌面开锚定下拉；onRowAction 分发六键', async () => {
    const m = mkOrch({ isMobile: true });
    m.o.openRowMenu({} as HTMLElement, ctx());
    expect(m.sheet.show).toHaveBeenCalledTimes(1);
    const d = mkOrch({ isMobile: false });
    d.o.openRowMenu({} as HTMLElement, ctx());
    expect(d.actionMenu.toggle).toHaveBeenCalledTimes(1);

    // 菜单上下文消费后清空（防陈旧 ctx 复用）
    d.o.menuCtx = ctx();
    d.o.onRowAction('move');
    expect(d.onStartMove).toHaveBeenCalledWith('doc1');
    expect(d.o.menuCtx).toBeNull();

    d.o.menuCtx = ctx({ name: 'n.md' });
    submitAction.mockResolvedValue(200);
    d.o.onRowAction('rename');
    expect(d.o.editingId).toBe('doc1');
    expect(d.o.renameValue).toBe('n.md');

    d.o.menuCtx = ctx({ tags: [{ id: 't', name: 'a' }] });
    d.o.onRowAction('tags');
    expect(d.o.taggingId).toBe('doc1');
    expect(d.o.tagInput).toBe('a');

    d.o.menuCtx = ctx();
    fetchShareUrl.mockResolvedValue('/s/1');
    d.o.onRowAction('share');
    await Promise.resolve();
    await Promise.resolve();
    expect(fetchShareUrl).toHaveBeenCalledWith('doc1');

    d.o.menuCtx = ctx();
    submitAction.mockResolvedValue(200);
    d.o.onRowAction('delete');
    await Promise.resolve();
    await Promise.resolve();
    expect(d.o.isRemoved('doc1')).toBe(true);
});
