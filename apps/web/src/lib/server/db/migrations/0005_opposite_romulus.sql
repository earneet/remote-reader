ALTER TABLE `documents` ADD `owner_viewed_at` integer;--> statement-breakpoint
CREATE INDEX `documents_owner_type_viewed_idx` ON `documents` (`owner_id`,`type`,"owner_viewed_at" DESC,"id" DESC);