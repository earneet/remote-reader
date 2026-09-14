import { sql } from 'drizzle-orm';
import { sqliteTable, text, integer, index, unique, primaryKey } from 'drizzle-orm/sqlite-core';

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
    ownerViewedAt: integer('owner_viewed_at')
}, (t) => ({
    ownerParentIdx: index('documents_owner_parent_idx').on(t.ownerId, t.parentId),
    ownerParentNameTypeIdx: index('documents_owner_parent_name_type_idx').on(t.ownerId, t.parentId, t.name, t.type),
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
