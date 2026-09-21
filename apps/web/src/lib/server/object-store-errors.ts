// 存储错误类与 GET 错误映射的叶子模块（交叉审查 P2：解开运行时值导入环）。
// 依赖方向约束（单向，禁止回指）：
//   blobstore-local / blobstore-s3 / object-store / object-store-s3 → 本文件
//   object-store → object-store-s3 → blobstore-s3 → 本文件
// 若本文件需要引用上述模块的东西，只允许 import type（不产生运行时环）。

// 远端对象缺失（语义对齐 storage.ts 的 FileNotFoundError → 路由层 404）
export class ObjectNotFoundError extends Error {
    readonly code = 'ARCHIVE_OBJECT_NOT_FOUND' as const;
    constructor(key: string) {
        super(`archived object not found: ${key}`);
        this.name = 'ObjectNotFoundError';
    }
}

// 远端不可达/未配置（路由层 → 503）
export class ArchiveUnavailableError extends Error {
    readonly code = 'ARCHIVE_UNAVAILABLE' as const;
    constructor(message: string, options?: { cause: unknown }) {
        super(message);
        this.name = 'ArchiveUnavailableError';
        if (options && 'cause' in options) this.cause = options.cause;
    }
}

// GET 错误映射：NoSuchKey / HTTP 404 → 对象缺失（404 语义）；其余 → 不可达（503 语义）
// 404 兜底：部分 S3 兼容网关对缺失对象返回非标准错误体（无 NoSuchKey Code），按状态码归类
export function mapGetError(key: string, e: unknown): Error {
    if ((e as { name?: string }).name === 'NoSuchKey') return new ObjectNotFoundError(key);
    if ((e as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) {
        return new ObjectNotFoundError(key);
    }
    return new ArchiveUnavailableError(`get ${key} 失败`, { cause: e });
}
