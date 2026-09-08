// 「最近文档」视图的共享契约：页面 load 与 /api/recent 端点都产出该形状，RecentList 组件只认它（spec §5.3/§6.2）。
// 服务端实际返回 DocumentRow & { tags }（字段是超集，结构兼容本类型）；目录视图的 children 今天就这么跨边界。
export const RECENT_PAGE_SIZE = 50;

export type RecentDoc = {
    id: string;
    parentId: string | null;
    name: string;
    type: 'file' | 'folder';
    sizeBytes: number | null;
    createdAt: number;
    updatedAt: number;
    storageTier: 'hot' | 'cold';
    tags: { id: string; name: string }[];
};
