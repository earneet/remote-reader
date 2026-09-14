CREATE TABLE `invite_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code_hash` text NOT NULL,
	`created_by` text NOT NULL,
	`note` text NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	`used_count` integer NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `invite_codes_code_hash_idx` ON `invite_codes` (`code_hash`);