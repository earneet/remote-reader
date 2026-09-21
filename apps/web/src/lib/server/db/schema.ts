import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, unique, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';

export const users = sqliteTable('users', {
    id: text('id').primaryKey(),
    email: text('email').notNull().unique(),
    passwordHash: text('password_hash').notNull(),
    role: text('role', { enum: ['admin', 'member'] }).notNull(),
    createdAt: integer('created_at').notNull()
});

export const apiTokens = sqliteTable('api_tokens', {
    id: text('id').primaryKey(),
    userId: text('user_id').notNull().references(() => users.id),
    name: text('name').notNull(),
    tokenHash: text('token_hash').notNull(),
    lastUsedAt: integer('last_used_at'),
    createdAt: integer('created_at').notNull()
}, (t) => ({
    userIdIdx: index('api_tokens_user_id_idx').on(t.userId),
    tokenHashIdx: index('api_tokens_token_hash_idx').on(t.tokenHash)
}));

export const inviteCodes = sqliteTable('invite_codes', {
    id: text('id').primaryKey(),
    codeHash: text('code_hash').notNull(),
    createdBy: text('created_by').notNull().references(() => users.id),
    note: text('note').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    usedCount: integer('used_count').notNull(),
    lastUsedAt: integer('last_used_at'),
    createdAt: integer('created_at').notNull()
}, (t) => ({
    codeHashIdx: index('invite_codes_code_hash_idx').on(t.codeHash)
}));

export const documents = sqliteTable('documents', {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull().references(() => users.id),
    parentId: text('parent_id'),
    name: text('name').notNull(),
    type: text('type', { enum: ['file', 'folder'] }).notNull(),
    storagePath: text('storage_path'),
    contentHash: text('content_hash'),
    sizeBytes: integer('size_bytes'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    storageTier: text('storage_tier', { enum: ['hot', 'cold'] }).notNull().default('hot'),
    lastViewedAt: integer('last_viewed_at'),
    archivedAt: integer('archived_at'),
    // 「最近浏览」信号（spec §5.1）：仅 owner 真实浏览（beacon 写入）；
    // 与 last_viewed_at（分层信号：任何人任何访问）语义分工，互不替代
    ownerViewedAt: integer('owner_viewed_at'),
    // 图片支持（spec 2026-09-20 §4.1）：冷档溯源列——NULL=hot（本地盘）；非空=cold 行的实际归档后端
    storageBackend: text('storage_backend')
}, (t) => ({
    ownerParentIdx: index('documents_owner_parent_idx').on(t.ownerId, t.parentId),
    ownerParentNameTypeIdx: index('documents_owner_parent_name_type_idx').on(t.ownerId, t.parentId, t.name, t.type),
    // P1-1：同位置同类型唯一（NULL parent_id 需 COALESCE 才参与唯一性）——拦截并发首传双插
    ownerParentNameTypeUniq: uniqueIndex('documents_owner_parent_name_type_uniq')
        .on(t.ownerId, sql`COALESCE(${t.parentId}, '')`, t.name, t.type),
    ownerTypeUpdatedIdx: index('documents_owner_type_updated_idx')
        .on(t.ownerId, t.type, sql`${t.updatedAt} DESC`, sql`${t.id} DESC`),
    ownerTypeViewedIdx: index('documents_owner_type_viewed_idx')
        .on(t.ownerId, t.type, sql`${t.ownerViewedAt} DESC`, sql`${t.id} DESC`)
}));

export const shareLinks = sqliteTable('share_links', {
    id: text('id').primaryKey(),
    documentId: text('document_id').notNull().references(() => documents.id),
    token: text('token').notNull().unique(),
    expiresAt: integer('expires_at'),
    createdAt: integer('created_at').notNull()
}, (t) => ({
    documentIdIdx: index('share_links_document_id_idx').on(t.documentId)
}));

export const tags = sqliteTable('tags', {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull().references(() => users.id),
    name: text('name').notNull(),
    createdAt: integer('created_at').notNull()
}, (t) => ({
    ownerNameUnique: unique('tags_owner_name_unique').on(t.ownerId, t.name),
    ownerIdx: index('tags_owner_id_idx').on(t.ownerId)
}));

export const documentTags = sqliteTable('document_tags', {
    tagId: text('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
    documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' })
}, (t) => ({
    pk: primaryKey({ columns: [t.tagId, t.documentId] }),
    docIdx: index('document_tags_document_id_idx').on(t.documentId),
    tagIdx: index('document_tags_tag_id_idx').on(t.tagId)
}));

// 图片资产池（spec 2026-09-20 §4.1）：owner 内内容寻址去重，脱离 documents 目录树。
// status 三态：pending（init 存根）/ ready（可引用可 serve）/ deleted（墓碑——UNIQUE 占位实现名字永不复用）
export const images = sqliteTable('images', {
    id: text('id').primaryKey(),
    ownerId: text('owner_id').notNull().references(() => users.id),
    name: text('name').notNull(),
    contentHash: text('content_hash').notNull(),
    contentMd5: text('content_md5').notNull(),
    mimeType: text('mime_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    status: text('status', { enum: ['pending', 'ready', 'deleted'] }).notNull().default('pending'),
    storageBackend: text('storage_backend').notNull(),
    storageKey: text('storage_key').notNull(),
    createdAt: integer('created_at').notNull(),
    readyAt: integer('ready_at')
}, (t) => ({
    ownerHashUniq: uniqueIndex('images_owner_hash_uniq').on(t.ownerId, t.contentHash),
    ownerNameUniq: uniqueIndex('images_owner_name_uniq').on(t.ownerId, t.name),
    statusCreatedIdx: index('images_status_created_idx').on(t.status, t.createdAt),
    statusReadyIdx: index('images_status_ready_idx').on(t.status, t.readyAt)
}));

// md ↔ 图片引用关系（N:N，兼代理路由 refs 白名单）；ON DELETE CASCADE 随文档删除清 refs
export const imageRefs = sqliteTable('image_refs', {
    documentId: text('document_id').notNull().references(() => documents.id, { onDelete: 'cascade' }),
    imageId: text('image_id').notNull().references(() => images.id),
    createdAt: integer('created_at').notNull()
}, (t) => ({
    pk: primaryKey({ columns: [t.documentId, t.imageId] }),
    imageIdx: index('image_refs_image_id_idx').on(t.imageId)
}));
