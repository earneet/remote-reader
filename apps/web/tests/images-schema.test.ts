import { describe, it, expect, beforeAll } from 'vitest';
import { sqlite, ensureSchema } from '$server/db';
import { resetDb } from './helpers';

// 三源一致性守卫（spec §4.1）：SCHEMA_SQL（新库路径）/ ensureSchema（存量库路径）/ drizzle 迁移（db:migrate 路径）
// 对 images / image_refs / documents.storage_backend 的结构断言。
// 注：测试库由根 vitest.config.ts 统一管理（per-run 库文件，helpers.ts 不设 DATABASE_PATH）；
// db/index.ts 模块加载即执行 ensureSchema()（含新表），beforeAll resetDb 保证起点数据干净。
beforeAll(() => resetDb());

describe('images schema', () => {
    it('images 表存在且列齐全', () => {
        const cols = sqlite.prepare('PRAGMA table_info(images)').all() as { name: string }[];
        const names = new Set(cols.map((c) => c.name));
        for (const c of [
            'id', 'owner_id', 'name', 'content_hash', 'content_md5', 'mime_type',
            'size_bytes', 'status', 'storage_backend', 'storage_key', 'created_at', 'ready_at'
        ]) expect(names.has(c), `缺列 ${c}`).toBe(true);
    });

    it('images 双 UNIQUE + 两回收索引存在', () => {
        const idx = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='images'")
            .all() as { name: string }[];
        const names = new Set(idx.map((i) => i.name));
        for (const n of ['images_owner_hash_uniq', 'images_owner_name_uniq', 'images_status_created_idx', 'images_status_ready_idx']) {
            expect(names.has(n), `缺索引 ${n}`).toBe(true);
        }
    });

    it('image_refs 复合主键 + image_id 索引 + document_id 级联', () => {
        const idx = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='image_refs'")
            .all() as { name: string }[];
        expect((idx.map((i) => i.name)).includes('image_refs_image_id_idx')).toBe(true);
        const fk = sqlite.prepare('PRAGMA foreign_key_list(image_refs)').all() as
            { table: string; from: string; on_delete: string }[];
        const docFk = fk.find((f) => f.table === 'documents' && f.from === 'document_id');
        expect(docFk?.on_delete).toBe('CASCADE');
    });

    it('documents.storage_backend 列存在（存量库升级兜底）', () => {
        const cols = sqlite.prepare('PRAGMA table_info(documents)').all() as { name: string }[];
        expect((cols.map((c) => c.name)).includes('storage_backend')).toBe(true);
    });

    it('存量冷档行回填 storage_backend=s3（幂等：二次执行不重复改写、已有值不覆盖、hot 行不动）', () => {
        sqlite.exec(`INSERT INTO users (id, email, password_hash, role, created_at)
            VALUES ('u-sb', 'sb@test.local', 'x', 'member', 0)`);
        // 三种存量形态：NULL 待回填 / 已有值（sentinel，幂等的"不覆盖"语义载体）/ 非 cold 行
        sqlite.exec(`INSERT INTO documents (id, owner_id, parent_id, name, type, created_at, updated_at, storage_tier, storage_backend)
            VALUES ('d-sb', 'u-sb', NULL, 'cold.md', 'file', 0, 0, 'cold', NULL),
                   ('d-sent', 'u-sb', NULL, 'sent.md', 'file', 0, 0, 'cold', 'custom'),
                   ('d-hot', 'u-sb', NULL, 'hot.md', 'file', 0, 0, 'hot', NULL)`);
        const backendOf = (id: string): string | null =>
            (sqlite.prepare('SELECT storage_backend AS b FROM documents WHERE id = ?').get(id) as { b: string | null }).b;
        ensureSchema(sqlite);
        expect(backendOf('d-sb')).toBe('s3');      // NULL cold 行回填
        expect(backendOf('d-sent')).toBe('custom'); // WHERE storage_backend IS NULL 挡住已有值（幂等真义）
        expect(backendOf('d-hot')).toBeNull();      // WHERE storage_tier='cold' 挡住非 cold 行
        ensureSchema(sqlite);                       // 二次执行：回填后的行不再命中 WHERE，全库不变
        expect(backendOf('d-sb')).toBe('s3');
        expect(backendOf('d-sent')).toBe('custom');
        expect(backendOf('d-hot')).toBeNull();
    });
});
