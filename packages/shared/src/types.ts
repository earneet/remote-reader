export type UserRole = 'admin' | 'member';

export interface User {
    id: string;
    email: string;
    role: UserRole;
    createdAt: number;
}

export type DocumentType = 'file' | 'folder';

export interface Document {
    id: string;
    ownerId: string;
    parentId: string | null;
    name: string;
    type: DocumentType;
    storagePath: string | null;
    contentHash: string | null;
    sizeBytes: number | null;
    createdAt: number;
    updatedAt: number;
}

export interface ApiToken {
    id: string;
    userId: string;
    name: string;
    tokenHash: string;
    lastUsedAt: number | null;
    createdAt: number;
}

export interface ShareLink {
    id: string;
    documentId: string;
    token: string;
    expiresAt: number | null;
    createdAt: number;
}

export interface UploadResult {
    id: string;
    url: string;
}
