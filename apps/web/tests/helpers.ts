import { db, schema, sqlite } from '../src/lib/server/db';

// 测试库清理级联的唯一实现：同一 vitest run 内全部文件共享一个 per-run 库文件
// （vitest.config.ts 在主进程按 pid 设置 DATABASE_PATH，跨 vitest 实例互不干扰；
// 每文件独立 fork + 顺序执行，模块/env 天然逐文件隔离），逐测试清空全部表防文件内串扰。
// FK 约束开启——顺序必须先子后父（image_refs → images →
// document_tags/tags → share_links → api_tokens → documents → invite_codes → users）。
// 新增表时只改这里（历史上曾在 20 个文件各改一遍）
export function resetDb(): void {
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.imageRefs).run();
    db.delete(schema.images).run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.documents).run();
    db.delete(schema.inviteCodes).run();
    db.delete(schema.users).run();
}
