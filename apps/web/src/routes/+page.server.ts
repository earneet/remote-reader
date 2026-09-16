import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
    createFolder, deleteNode, listChildren, listFolders, folderChildCounts,
    moveNode, recentFiles, renameNode, toDocDTO
} from '$server/documents';
import { sharedDocIds } from '$server/shares';
import { listTags, listTagsForDocs, setDocTags, SetTagsError } from '$server/tags';
import { parsePath } from '@remote-reader/shared/paths';
import { RECENT_PAGE_SIZE } from '$lib/shared/recent';

// M10: 文件管理器输入也经 sanitize，与 API 上传语义一致。名称必须是单段合法名。
function sanitizeSingleName(raw: string): string {
    const parts = parsePath(raw);
    if (parts.length !== 1) throw new Error('名称不能包含路径分隔符');
    return parts[0];
}

export const load: PageServerLoad = async ({ locals, url }) => {
    if (!locals.user) redirect(302, '/login');
    const rawView = url.searchParams.get('view');
    const view = rawView === 'recent' ? 'recent' as const
        : rawView === 'viewed' ? 'viewed' as const
        : 'dir' as const;
    // 公共数据：左树（folders/计数）+ 标签编辑（allTags）所有视图都要（spec §6.1）
    const folders = listFolders(locals.user.id).map((r) => toDocDTO(r));
    const folderCounts = folderChildCounts(locals.user.id);
    const allTags = listTags(locals.user.id);
    if (view === 'recent' || view === 'viewed') {
        const rows = recentFiles(locals.user.id, view === 'viewed' ? 'viewed' : 'updated', null, RECENT_PAGE_SIZE);
        const tagsByDoc = listTagsForDocs(rows.map((r) => r.id), locals.user.id);
        const sharedIds = sharedDocIds(locals.user.id, rows.filter((r) => r.type === 'file').map((r) => r.id));
        const list = rows.map((r) => ({ ...toDocDTO(r, sharedIds.has(r.id)), tags: tagsByDoc.get(r.id) ?? [] }));
        return {
            view, children: [], folders, currentDir: null, tagsByDoc, allTags, folderCounts,
            recent: view === 'recent' ? list : [],
            viewed: view === 'viewed' ? list : []
        };
    }
    const dir = url.searchParams.get('dir');
    const parentId = dir && dir.length > 0 ? dir : null;
    const rows = listChildren(locals.user.id, parentId);
    const fileIds = rows.filter((r) => r.type === 'file').map((r) => r.id);
    const tagsByDoc = listTagsForDocs(fileIds, locals.user.id);
    const sharedIds = sharedDocIds(locals.user.id, fileIds);
    const children = rows.map((r) => toDocDTO(r, sharedIds.has(r.id)));
    return { view, children, folders, currentDir: parentId, tagsByDoc, allTags, folderCounts, recent: [], viewed: [] };
};

export const actions: Actions = {
    createFolder: async ({ request, locals, url }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const rawName = String(form.get('name') ?? '').trim();
        const dir = url.searchParams.get('dir');
        const parentId = dir && dir.length > 0 ? dir : null;
        if (!rawName) return fail(400, { error: '名称必填' });
        let name: string;
        try {
            name = sanitizeSingleName(rawName);
        } catch (e) {
            return fail(400, { error: (e as Error).message });
        }
        const r = createFolder(locals.user.id, parentId, name);
        if (!r.ok) return fail(409, { error: r.reason });
        return { ok: true };
    },
    rename: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const id = String(form.get('id') ?? '');
        const rawName = String(form.get('name') ?? '').trim();
        if (!id || !rawName) return fail(400, { error: '参数缺失' });
        let name: string;
        try {
            name = sanitizeSingleName(rawName);
        } catch (e) {
            return fail(400, { error: (e as Error).message });
        }
        const r = renameNode(locals.user.id, id, name);
        if (!r.ok) {
            if (r.code === 'conflict') return fail(409, { error: r.reason ?? '重名' });
            return fail(404, { error: r.reason ?? '文档不存在' });
        }
        return { ok: true };
    },
    move: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const id = String(form.get('id') ?? '');
        const target = String(form.get('target') ?? '');
        if (!id) return fail(400, { error: '参数缺失' });
        const newParentId = target === 'root' || !target ? null : target;
        const r = moveNode(locals.user.id, id, newParentId);
        if (!r.ok) {
            if (r.code === 'conflict') return fail(409, { error: r.reason ?? '目标存在同名' });
            return fail(400, { error: r.reason ?? '移动失败' });
        }
        return { ok: true };
    },
    delete: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const id = String(form.get('id') ?? '');
        if (!id) return fail(400, { error: '参数缺失' });
        deleteNode(locals.user.id, id);
        return { ok: true };
    },
    setTags: async ({ request, locals }) => {
        if (!locals.user) redirect(302, '/login');
        const form = await request.formData();
        const id = String(form.get('id') ?? '');
        const raw = String(form.get('tags') ?? '');
        if (!id) return fail(400, { error: '参数缺失' });
        const names = raw.split(',').map(s => s.trim()).filter(Boolean);
        for (const n of names) {
            if (!n || n.length > 32 || n.includes('/')) return fail(400, { error: `标签名非法：${n}` });
        }
        try {
            setDocTags(locals.user.id, id, names);
        } catch (e) {
            if (e instanceof SetTagsError) return fail(404, { error: '文档不存在或无权操作' });
            throw e;
        }
        return { ok: true };
    }
};
