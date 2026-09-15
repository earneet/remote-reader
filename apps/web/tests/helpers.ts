import { db, schema, sqlite } from '../src/lib/server/db';

// 测试库清理级联的唯一实现：vitest fileParallelism:false 下全部测试共享一个 DB 文件，
// 逐测试清空全部表。FK 约束开启——顺序必须先子后父（document_tags/tags → share_links →
// api_tokens → documents → invite_codes → users）。
// 新增表时只改这里（历史上曾在 20 个文件各改一遍）
export function resetDb(): void {
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.documents).run();
    db.delete(schema.inviteCodes).run();
    db.delete(schema.users).run();
}
