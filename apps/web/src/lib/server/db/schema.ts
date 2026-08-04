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
    updatedAt: integer('updated_at').notNull()
}, (t) => ({
    ownerParentIdx: index('documents_owner_parent_idx').on(t.ownerId, t.parentId),
    ownerParentNameTypeIdx: index('documents_owner_parent_name_type_idx').on(t.ownerId, t.parentId, t.name, t.type)
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
