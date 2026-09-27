// FM 页与 RecentList 的行操作编排层单源（R-06）：confirm → submitAction/fetch → 刷新 →
// 错误反馈 的完整链路原先两份组件各写一遍且已漂移（乐观移除单侧有、错误通道各一条）。
// 组件保留视图职责（列表渲染/行内表单挂载），操作语义全部收敛到本类；
// ActionSheet/ActionMenu/ShareDialog 三浮层由宿主页面持有一份，经 bind:this 绑到本类槽位。
import type ActionSheet from '$components/ActionSheet.svelte';
import type ActionMenu from '$components/ActionMenu.svelte';
import type ShareDialog from '$components/ShareDialog.svelte';
import { submitAction, actionErrorMessage } from './form-action';
import { fetchShareUrl, revokeDocShares } from './share-api';

export interface RowCtx {
    id: string;
    name: string;
    type: string;
    shared: boolean;
    tags: Array<{ id: string; name: string }>;
}

export interface RowOrchestratorOpts {
    isMobile: () => boolean;
    /** 操作成功后的统一刷新（目录视图 invalidateAll + recent reSync 双刷；失败语义由调用方定） */
    refresh: () => Promise<void>;
    onStartMove: (id: string) => void;
}

export class RowActionOrchestrator {
    menuCtx = $state<RowCtx | null>(null);
    editingId = $state<string | null>(null);
    renameValue = $state('');
    taggingId = $state<string | null>(null);
    tagInput = $state('');
    busyId = $state<string | null>(null);
    actionError = $state<string | null>(null);
    renameError = $state<string | null>(null);
    tagError = $state<string | null>(null);
    sheet = $state<ActionSheet | null>(null);
    actionMenu = $state<ActionMenu | null>(null);
    shareDialog = $state<ShareDialog | null>(null);
    // 删除乐观移除（两端统一语义）：refresh 失败也不残留已删行；数组赋值保反应性
    removedIds = $state<string[]>([]);

    constructor(private readonly opts: RowOrchestratorOpts) {}

    isRemoved(id: string): boolean {
        return this.removedIds.includes(id);
    }

    /** ⋯ 入口路由：移动端底部 sheet，桌面锚定下拉 */
    openRowMenu(anchor: HTMLElement, item: RowCtx): void {
        this.menuCtx = item;
        if (this.opts.isMobile()) this.sheet?.show();
        else this.actionMenu?.toggle(anchor);
    }

    onRowAction(key: string): void {
        const it = this.menuCtx;
        this.menuCtx = null;
        if (!it) return;
        if (key === 'rename') this.startRename(it);
        else if (key === 'tags') this.startTags(it);
        else if (key === 'move') this.opts.onStartMove(it.id);
        else if (key === 'share') void this.doShare(it.id);
        else if (key === 'unshare') void this.doUnshare(it.id);
        else if (key === 'delete') void this.doDelete(it.id, it.type);
    }

    startRename(item: RowCtx): void {
        this.editingId = item.id;
        this.renameValue = item.name;
        this.renameError = null;
    }

    cancelRename(): void {
        this.editingId = null;
        this.renameError = null;
    }

    startTags(item: RowCtx): void {
        this.taggingId = item.id;
        this.tagInput = item.tags.map((t) => t.name).join(', ');
        this.tagError = null;
    }

    async doRename(id: string, name: string): Promise<void> {
        if (!name) return;
        this.busyId = id;
        this.renameError = null;
        const status = await submitAction('rename', { id, name });
        this.busyId = null;
        if (status === 200) {
            this.editingId = null;
            await this.opts.refresh();
        } else {
            this.renameError = actionErrorMessage(status); // 失败保持编辑态 + 展示原因，可改可取消
        }
    }

    async doSetTags(id: string, tags: string): Promise<void> {
        this.busyId = id;
        this.tagError = null;
        const status = await submitAction('setTags', { id, tags });
        this.busyId = null;
        if (status === 200) {
            this.taggingId = null;
            this.tagInput = '';
            await this.opts.refresh();
        } else {
            this.tagError = actionErrorMessage(status);
        }
    }

    /** 复制分享链接（get-or-create）：成功后刷新（私有→共享图标翻转）再弹浮层 */
    async doShare(id: string): Promise<void> {
        this.busyId = id;
        try {
            const url = await fetchShareUrl(id);
            if (!url) throw new Error('share failed');
            await this.opts.refresh();
            this.shareDialog?.show(url);
        } catch {
            this.actionError = '获取分享链接失败，请重试';
        } finally {
            this.busyId = null;
        }
    }

    /** 转为私有：撤销该文档全部分享链接（404=文档已不在也算完成，幂等） */
    async doUnshare(id: string): Promise<void> {
        if (!confirm('转为私有后，该文档的所有分享链接立即失效（已发出的链接将无法再打开），且不可恢复。继续？')) return;
        this.busyId = id;
        try {
            if (!(await revokeDocShares(id))) throw new Error('unshare failed');
            this.actionError = null;
            await this.opts.refresh();
        } catch {
            this.actionError = '转为私有失败，请重试';
        } finally {
            this.busyId = null;
        }
    }

    async doDelete(id: string, type: string): Promise<void> {
        const msg = type === 'folder'
            ? '确认删除该文件夹？将级联删除其全部内容，且不可恢复。'
            : '确认删除该文件？此操作不可恢复。';
        if (!confirm(msg)) return;
        this.busyId = id;
        const status = await submitAction('delete', { id });
        this.busyId = null;
        if (status === 200 || status === 404) {
            this.actionError = null;
            this.removedIds = [...this.removedIds, id];
            await this.opts.refresh();
        } else {
            this.actionError = actionErrorMessage(status);
        }
    }
}
