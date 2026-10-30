CREATE TABLE `drive_conflicts` (
	`drive_a_id` text NOT NULL,
	`drive_b_id` text NOT NULL,
	`reason` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`drive_a_id`, `drive_b_id`),
	FOREIGN KEY (`drive_a_id`) REFERENCES `drives`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`drive_b_id`) REFERENCES `drives`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "drive_conflicts_ordered" CHECK("drive_conflicts"."drive_a_id" < "drive_conflicts"."drive_b_id"),
	CONSTRAINT "drive_conflicts_reason_length" CHECK("drive_conflicts"."reason" IS NULL OR (length("drive_conflicts"."reason") >= 1 AND length("drive_conflicts"."reason") <= 200))
);
--> statement-breakpoint
CREATE INDEX `drive_conflicts_drive_b_idx` ON `drive_conflicts` (`drive_b_id`);--> statement-breakpoint
-- Hand-edited (AGENTS.md section 6). The CHECK lists on activities.kind and events.type name the new
-- conflict-added / conflict-removed values, and SQLite cannot alter a CHECK, so both tables are rebuilt.
-- drizzle-kit's generated rebuild is NOT safe here: its DROP TABLE `activities` runs inside the
-- migration transaction, where `PRAGMA foreign_keys` is a no-op, so the ON DELETE CASCADE from events
-- would delete every event before events is copied. Instead the rows are parked in plain copies, the
-- child (events) is dropped before the parent (activities), both are recreated under their final
-- names (no RENAME) and refilled from the copies. No row is changed or dropped.
CREATE TABLE `__activities_copy` AS SELECT * FROM `activities`;--> statement-breakpoint
CREATE TABLE `__events_copy` AS SELECT * FROM `events`;--> statement-breakpoint
DROP TABLE `events`;--> statement-breakpoint
DROP TABLE `activities`;--> statement-breakpoint
CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`recorded_at` text NOT NULL,
	`occurred_on` text,
	`note` text,
	CONSTRAINT "activities_kind_enum" CHECK(kind IN ('drive-added', 'discovered-created', 'discovered-linked', 'retired-imported', 'drive-edited', 'suggestions-applied', 'suggestions-dismissed', 'suggestions-restored', 'assigned', 'replaced', 'removed', 'retired', 'sent-for-rma', 'reinstated', 'moved', 'swapped', 'pool-joined', 'pool-left', 'pool-role-changed', 'pool-changed', 'health-polled', 'layout-updated', 'pool-edited', 'conflict-added', 'conflict-removed'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activities_seq_unique` ON `activities` (`seq`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`activity_id` text NOT NULL,
	`ord` integer NOT NULL,
	`type` text NOT NULL,
	`drive_id` text,
	`slot_id` text,
	`slot_label` text,
	`grid_id` text,
	`grid_name` text,
	`pool_id` text,
	`pool_name` text,
	`payload` text NOT NULL,
	FOREIGN KEY (`activity_id`) REFERENCES `activities`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`drive_id`) REFERENCES `drives`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "events_type_enum" CHECK(type IN ('drive-created', 'drive-updated', 'drive-linked', 'drive-installed', 'drive-uninstalled', 'installation-updated', 'pool-joined', 'pool-left', 'pool-role-changed', 'drive-retired', 'drive-sent-for-rma', 'drive-reinstated', 'health-changed', 'suggestion-dismissed', 'enclosure-created', 'enclosure-renamed', 'enclosure-deleted', 'grid-created', 'grid-updated', 'grid-deleted', 'slot-relabeled', 'pool-created', 'pool-updated', 'pool-deleted', 'conflict-added', 'conflict-removed'))
);
--> statement-breakpoint
CREATE INDEX `events_drive_idx` ON `events` (`drive_id`);--> statement-breakpoint
CREATE INDEX `events_slot_idx` ON `events` (`slot_id`);--> statement-breakpoint
CREATE INDEX `events_pool_idx` ON `events` (`pool_id`);--> statement-breakpoint
CREATE INDEX `events_activity_ord_idx` ON `events` (`activity_id`,`ord`);--> statement-breakpoint
INSERT INTO `activities`(`id`, `seq`, `kind`, `recorded_at`, `occurred_on`, `note`) SELECT `id`, `seq`, `kind`, `recorded_at`, `occurred_on`, `note` FROM `__activities_copy`;--> statement-breakpoint
INSERT INTO `events`(`id`, `activity_id`, `ord`, `type`, `drive_id`, `slot_id`, `slot_label`, `grid_id`, `grid_name`, `pool_id`, `pool_name`, `payload`) SELECT `id`, `activity_id`, `ord`, `type`, `drive_id`, `slot_id`, `slot_label`, `grid_id`, `grid_name`, `pool_id`, `pool_name`, `payload` FROM `__events_copy`;--> statement-breakpoint
DROP TABLE `__events_copy`;--> statement-breakpoint
DROP TABLE `__activities_copy`;
