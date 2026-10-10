CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `provider_snapshot` (
	`id` integer PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`observations` text NOT NULL,
	`last_success_at` text,
	`last_attempt_at` text,
	`last_error` text,
	CONSTRAINT "provider_snapshot_singleton" CHECK("provider_snapshot"."id" = 1)
);
