import type { BlobStore } from './blobstore';
import type { ObjectStoreConfig } from './object-store';

export class S3BlobStore implements BlobStore {
    readonly id = 's3';
    constructor(_config: ObjectStoreConfig) { void _config; }
    async put(): Promise<void> { throw new Error('TODO Task 7'); }
    async get(): Promise<Buffer> { throw new Error('TODO Task 7'); }
    async delete(): Promise<void> { throw new Error('TODO Task 7'); }
}
