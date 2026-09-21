import type { BlobStore } from './blobstore';

export class LocalBlobStore implements BlobStore {
    readonly id = 'local';
    async put(): Promise<void> { throw new Error('TODO Task 6'); }
    async get(): Promise<Buffer> { throw new Error('TODO Task 6'); }
    async delete(): Promise<void> { throw new Error('TODO Task 6'); }
}
