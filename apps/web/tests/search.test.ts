import { test, expect, beforeEach } from 'vitest';
import { db, schema, sqlite } from '../src/lib/server/db';
import { generateId } from '../src/lib/server/auth';
import { uploadDocument } from '../src/lib/server/documents';
import { setDocTags } from '../src/lib/server/tags';
import { searchDocuments, getDocPath } from '../src/lib/server/search';
import { eq, and } from 'drizzle-orm';

let ownerId: string;
const now = () => Date.now();

beforeEach(() => {
    sqlite.prepare('DELETE FROM docs_fts').run();
    db.delete(schema.documentTags).run();
    db.delete(schema.tags).run();
    db.delete(schema.shareLinks).run();
    db.delete(schema.apiTokens).run();
    db.delete(schema.documents).run();
    db.delete(schema.users).run();
    ownerId = generateId();
    db.insert(schema.users).values(
        { id: ownerId, email: `s-${Date.now()}@x.com`, passwordHash: 'x', role: 'member', createdAt: now() }
    ).run();
});

test('全文命中正文关键词（≥3 字走 FTS trigram，带 snippet）', async () => {
    await uploadDocument(ownerId, 'a.md', '本周项目周报进展顺利', []);
    const r = searchDocuments(ownerId, '周报进', []);
    expect(r.length).toBe(1);
    expect(r[0].doc.name).toBe('a.md');
    expect(r[0].snippet).toContain('<mark>');
});

test('2 字查询走 content LIKE 兜底命中（trigram 不支持 2-gram，无 snippet）', async () => {
    await uploadDocument(ownerId, 'a.md', '本周项目周报进展顺利', []);
    const r = searchDocuments(ownerId, '周报', []);
    expect(r.length).toBe(1);
    expect(r[0].doc.name).toBe('a.md');
});

test('文件名 LIKE 命中（正文无该词）', async () => {
    await uploadDocument(ownerId, 'meeting-notes.md', '普通内容', []);
    const r = searchDocuments(ownerId, 'meeting', []);
    expect(r.length).toBe(1);
    expect(r[0].doc.name).toBe('meeting-notes.md');
});

test('标签筛选（单标签）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    await uploadDocument(ownerId, 'b.md', 'y', []);
    setDocTags(ownerId, a.id, ['important']);
    const r = searchDocuments(ownerId, '', ['important']);
    expect(r.length).toBe(1);
    expect(r[0].doc.name).toBe('a.md');
});

test('标签多选取交集', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    const b = await uploadDocument(ownerId, 'b.md', 'y', []);
    setDocTags(ownerId, a.id, ['t1', 't2']);
    setDocTags(ownerId, b.id, ['t1']);
    const r = searchDocuments(ownerId, '', ['t1', 't2']);
    expect(r.length).toBe(1);
    expect(r[0].doc.name).toBe('a.md');
});

test('关键词 + 标签组合（交集）', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'unique_kw', []);
    await uploadDocument(ownerId, 'b.md', 'unique_kw', []);
    setDocTags(ownerId, a.id, ['vip']);
    const r = searchDocuments(ownerId, 'unique_kw', ['vip']);
    expect(r.length).toBe(1);
    expect(r[0].doc.name).toBe('a.md');
});

test('owner 隔离：搜不到他人文档', async () => {
    await uploadDocument(ownerId, 'a.md', 'secret_keyword_xyz', []);
    const r = searchDocuments('other-user', 'secret_keyword_xyz', []);
    expect(r.length).toBe(0);
});

test('空查询 + 空标签返回 []', async () => {
    await uploadDocument(ownerId, 'a.md', 'x', []);
    expect(searchDocuments(ownerId, '', [])).toEqual([]);
});

test('FTS 特殊字符不报错（双引号、星号）', async () => {
    await uploadDocument(ownerId, 'a.md', 'hello world', []);
    expect(() => searchDocuments(ownerId, '"*AND', [])).not.toThrow();
    expect(searchDocuments(ownerId, '"*AND', []).length).toBe(0);
});

test('snippet 转义正文 HTML（防 XSS）', async () => {
    await uploadDocument(ownerId, 'a.md', '<script>x</script> 命中词语', []);
    const r = searchDocuments(ownerId, '命中词语', []);
    expect(r.length).toBe(1);
    expect(r[0].snippet).not.toContain('<script>');
    expect(r[0].snippet).toContain('&lt;script&gt;');
});

test('LIKE 通配符转义：文件名中的 _ 按字面匹配', async () => {
    await uploadDocument(ownerId, 'a_b.md', 'x', []);
    await uploadDocument(ownerId, 'axb.md', 'y', []);
    const r = searchDocuments(ownerId, 'a_b', []);
    expect(r.length).toBe(1);
    expect(r[0].doc.name).toBe('a_b.md');
});

test('标签交集为空（某标签无文档）返回 []', async () => {
    const a = await uploadDocument(ownerId, 'a.md', 'x', []);
    setDocTags(ownerId, a.id, ['t1']);
    const r = searchDocuments(ownerId, '', ['t1', 'nonexistent']);
    expect(r).toEqual([]);
});

test('getDocPath 返回祖先链（根→父，不含文档本身）', async () => {
    const r = await uploadDocument(ownerId, 'a.md', 'x', ['rep', '2026']);
    const path = getDocPath(ownerId, r.id);
    expect(path.map(p => p.name)).toEqual(['rep', '2026']);
});
