-- docs_fts 由运行时 ensureSchema 维护、不在 0000~0006 迁移内——迁移路径的库需先确保其存在
CREATE VIRTUAL TABLE IF NOT EXISTS `docs_fts` USING fts5(`doc_id` UNINDEXED, `name`, `content`, tokenize = 'trigram');
--> statement-breakpoint
-- P1-1 前置清洗：删除并发首传竞态产生的同 (owner_id, IFNULL(parent_id,''), name, type) 重复行
-- （保留 rowid 最小者 = findNode().get() 实际命中的行；share_links/docs_fts 无级联须先清，
--  document_tags 由 ON DELETE cascade 随行删除）
DELETE FROM share_links WHERE document_id IN (
    SELECT d.id FROM documents d JOIN (
        SELECT owner_id, IFNULL(parent_id, '') AS pid, name, type, MIN(rowid) AS keep_rowid
        FROM documents GROUP BY owner_id, IFNULL(parent_id, ''), name, type HAVING COUNT(*) > 1
    ) g ON d.owner_id = g.owner_id AND IFNULL(d.parent_id, '') = g.pid
      AND d.name = g.name AND d.type = g.type AND d.rowid > g.keep_rowid
);
--> statement-breakpoint
DELETE FROM docs_fts WHERE doc_id IN (
    SELECT d.id FROM documents d JOIN (
        SELECT owner_id, IFNULL(parent_id, '') AS pid, name, type, MIN(rowid) AS keep_rowid
        FROM documents GROUP BY owner_id, IFNULL(parent_id, ''), name, type HAVING COUNT(*) > 1
    ) g ON d.owner_id = g.owner_id AND IFNULL(d.parent_id, '') = g.pid
      AND d.name = g.name AND d.type = g.type AND d.rowid > g.keep_rowid
);
--> statement-breakpoint
DELETE FROM documents WHERE id IN (
    SELECT d.id FROM documents d JOIN (
        SELECT owner_id, IFNULL(parent_id, '') AS pid, name, type, MIN(rowid) AS keep_rowid
        FROM documents GROUP BY owner_id, IFNULL(parent_id, ''), name, type HAVING COUNT(*) > 1
    ) g ON d.owner_id = g.owner_id AND IFNULL(d.parent_id, '') = g.pid
      AND d.name = g.name AND d.type = g.type AND d.rowid > g.keep_rowid
);
--> statement-breakpoint
CREATE UNIQUE INDEX `documents_owner_parent_name_type_uniq` ON `documents` (`owner_id`, COALESCE(`parent_id`, ''), `name`, `type`);