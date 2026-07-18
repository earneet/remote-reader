import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

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
});

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
});

export const shareLinks = sqliteTable('share_links', {
    id: text('id').primaryKey(),
    documentId: text('document_id').notNull().references(() => documents.id),
    token: text('token').notNull().unique(),
    expiresAt: integer('expires_at'),
    createdAt: integer('created_at').notNull()
});
