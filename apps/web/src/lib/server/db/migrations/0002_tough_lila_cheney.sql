CREATE TABLE `document_tags` (
	`tag_id` text NOT NULL,
	`document_id` text NOT NULL,
	PRIMARY KEY(`tag_id`, `document_id`),
	FOREIGN KEY (`tag_id`) REFERENCES `tags`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `document_tags_document_id_idx` ON `document_tags` (`document_id`);--> statement-breakpoint
CREATE INDEX `document_tags_tag_id_idx` ON `document_tags` (`tag_id`);--> statement-breakpoint
CREATE TABLE `tags` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tags_owner_id_idx` ON `tags` (`owner_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `tags_owner_name_unique` ON `tags` (`owner_id`,`name`);