CREATE TABLE `alert_rules` (
	`user_id` text PRIMARY KEY NOT NULL,
	`cpu` integer,
	`mem` integer,
	`disk` integer,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `probe_snapshots` ADD `cpu_usage` real;--> statement-breakpoint
ALTER TABLE `probe_snapshots` ADD `mem_pct` real;