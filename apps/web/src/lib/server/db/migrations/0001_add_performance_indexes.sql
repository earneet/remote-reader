CREATE INDEX `api_tokens_user_id_idx` ON `api_tokens` (`user_id`);--> statement-breakpoint
CREATE INDEX `api_tokens_token_hash_idx` ON `api_tokens` (`token_hash`);--> statement-breakpoint
CREATE INDEX `documents_owner_parent_idx` ON `documents` (`owner_id`,`parent_id`);--> statement-breakpoint
CREATE INDEX `documents_owner_parent_name_type_idx` ON `documents` (`owner_id`,`parent_id`,`name`,`type`);--> statement-breakpoint
CREATE INDEX `share_links_document_id_idx` ON `share_links` (`document_id`);