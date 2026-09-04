ALTER TABLE `documents` ADD `storage_tier` text DEFAULT 'hot' NOT NULL;--> statement-breakpoint
ALTER TABLE `documents` ADD `last_viewed_at` integer;--> statement-breakpoint
ALTER TABLE `documents` ADD `archived_at` integer;