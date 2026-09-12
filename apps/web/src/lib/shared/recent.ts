// 「最近文档」/「最近浏览」视图的共享契约：页面 load 与 /api/recent 端点都产出该形状，RecentList 组件只认它（spec §5.3/§6.2）。
// 服务端实际返回 DocumentRow & { tags }（字段是超集，结构兼容本类型）；目录视图的 children 今天就这么跨边界。
export const RECENT_PAGE_SIZE = 50;

// 排序维度（spec §5.4/§6.2）：updated = updated_at（「最近文档」）；viewed = owner_viewed_at（「最近浏览」）
export type RecentSort = 'updated' | 'viewed';

export type RecentDoc = {
    id: string;
    parentId: string | null;
    name: string;
    type: 'file' | 'folder';
    sizeBytes: number | null;
    createdAt: number;
    updatedAt: number;
    ownerViewedAt: number | null;
    storageTier: 'hot' | 'cold';
    tags: { id: string; name: string }[];
};
