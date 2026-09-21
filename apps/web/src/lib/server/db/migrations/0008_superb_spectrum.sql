CREATE TABLE `image_refs` (
	`document_id` text NOT NULL,
	`image_id` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`document_id`, `image_id`),
	FOREIGN KEY (`document_id`) REFERENCES `documents`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`image_id`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `image_refs_image_id_idx` ON `image_refs` (`image_id`);--> statement-breakpoint
CREATE TABLE `images` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`name` text NOT NULL,
	`content_hash` text NOT NULL,
	`content_md5` text NOT NULL,
	`mime_type` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`storage_backend` text NOT NULL,
	`storage_key` text NOT NULL,
	`created_at` integer NOT NULL,
	`ready_at` integer,
	FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `images_owner_hash_uniq` ON `images` (`owner_id`,`content_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `images_owner_name_uniq` ON `images` (`owner_id`,`name`);--> statement-breakpoint
CREATE INDEX `images_status_created_idx` ON `images` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `images_status_ready_idx` ON `images` (`status`,`ready_at`);--> statement-breakpoint
ALTER TABLE `documents` ADD `storage_backend` text;