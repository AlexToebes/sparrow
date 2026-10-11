CREATE TABLE `app_meta` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `drives` (
	`id` text PRIMARY KEY NOT NULL,
	`serial` text NOT NULL,
	`serial_normalized` text NOT NULL,
	`wwn` text,
	`model` text,
	`capacity_bytes` integer,
	`drive_type` text,
	`form_factor` text,
	`storage_location` text,
	`condition` text,
	`last_test_date` text,
	`purchase_date` text,
	`warranty_expiry` text,
	`vendor` text,
	`notes` text,
	`status` text NOT NULL,
	`slot_id` text,
	`retirement_reason` text,
	`retirement_date` text,
	`retirement_note` text,
	`installed_on` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`slot_id`) REFERENCES `slots`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "drives_slot_only_when_installed" CHECK("drives"."slot_id" IS NULL OR "drives"."status" = 'installed'),
	CONSTRAINT "drives_installed_needs_slot" CHECK("drives"."status" <> 'installed' OR "drives"."slot_id" IS NOT NULL),
	CONSTRAINT "drives_installed_on_only_when_installed" CHECK("drives"."installed_on" IS NULL OR "drives"."status" = 'installed'),
	CONSTRAINT "drives_retired_needs_reason" CHECK("drives"."status" <> 'retired' OR "drives"."retirement_reason" IS NOT NULL),
	CONSTRAINT "drives_drive_type_enum" CHECK(drive_type IS NULL OR drive_type IN ('HDD', 'SSD', 'NVMe')),
	CONSTRAINT "drives_status_enum" CHECK(status IN ('spare', 'installed', 'retired')),
	CONSTRAINT "drives_condition_enum" CHECK(condition IS NULL OR condition IN ('new', 'used', 'tested')),
	CONSTRAINT "drives_retirement_reason_enum" CHECK(retirement_reason IS NULL OR retirement_reason IN ('failed', 'replaced', 'other'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drives_serial_normalized_unique` ON `drives` (`serial_normalized`);--> statement-breakpoint
CREATE UNIQUE INDEX `drives_slot_id_unique` ON `drives` (`slot_id`);--> statement-breakpoint
CREATE TABLE `enclosures` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "enclosures_name_not_empty" CHECK(length("enclosures"."name") > 0)
);
--> statement-breakpoint
CREATE TABLE `event_drives` (
	`event_id` text NOT NULL,
	`drive_id` text NOT NULL,
	`role` text NOT NULL,
	PRIMARY KEY(`event_id`, `drive_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`drive_id`) REFERENCES `drives`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "event_drives_role_enum" CHECK(role IN ('subject', 'outgoing', 'incoming'))
);
--> statement-breakpoint
CREATE INDEX `event_drives_drive_idx` ON `event_drives` (`drive_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `event_pools` (
	`event_id` text NOT NULL,
	`pool_id` text NOT NULL,
	`pool_name` text NOT NULL,
	PRIMARY KEY(`event_id`, `pool_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_pools_pool_idx` ON `event_pools` (`pool_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `event_slots` (
	`event_id` text NOT NULL,
	`slot_id` text NOT NULL,
	`role` text NOT NULL,
	`slot_label` text,
	`grid_id` text NOT NULL,
	`grid_name` text NOT NULL,
	PRIMARY KEY(`event_id`, `slot_id`, `role`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "event_slots_role_enum" CHECK(role IN ('from', 'to', 'at'))
);
--> statement-breakpoint
CREATE INDEX `event_slots_slot_idx` ON `event_slots` (`slot_id`,`event_id`);--> statement-breakpoint
CREATE TABLE `events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`at` text NOT NULL,
	`payload` text NOT NULL,
	CONSTRAINT "events_type_enum" CHECK(type IN ('drive-created', 'drive-updated', 'drive-linked', 'drive-installed', 'drive-removed', 'drive-retired', 'drive-sent-for-rma', 'drive-reinstated', 'drive-moved', 'drives-swapped', 'drive-replaced', 'pool-joined', 'pool-left', 'pool-role-changed', 'health-changed', 'suggestion-dismissed', 'enclosure-created', 'enclosure-renamed', 'enclosure-deleted', 'grid-created', 'grid-updated', 'grid-deleted', 'slot-relabeled', 'pool-created', 'pool-updated', 'pool-deleted'))
);
--> statement-breakpoint
CREATE INDEX `events_at_idx` ON `events` (`at`);--> statement-breakpoint
CREATE TABLE `grids` (
	`id` text PRIMARY KEY NOT NULL,
	`enclosure_id` text NOT NULL,
	`name` text NOT NULL,
	`rows` integer NOT NULL,
	`columns` integer NOT NULL,
	`orientation` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`enclosure_id`) REFERENCES `enclosures`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "grids_name_not_empty" CHECK(length("grids"."name") > 0),
	CONSTRAINT "grids_rows_min" CHECK("grids"."rows" >= 1),
	CONSTRAINT "grids_columns_min" CHECK("grids"."columns" >= 1),
	CONSTRAINT "grids_orientation_enum" CHECK(orientation IN ('landscape', 'portrait'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `grids_enclosure_name_unique` ON `grids` (`enclosure_id`,`name`);--> statement-breakpoint
CREATE TABLE `memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`drive_id` text NOT NULL,
	`pool_id` text NOT NULL,
	`role` text NOT NULL,
	`source` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`drive_id`) REFERENCES `drives`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pool_id`) REFERENCES `pools`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "memberships_ended_after_started" CHECK("memberships"."ended_at" IS NULL OR "memberships"."ended_at" >= "memberships"."started_at"),
	CONSTRAINT "memberships_role_enum" CHECK(role IN ('data', 'hot-spare')),
	CONSTRAINT "memberships_source_enum" CHECK(source IN ('manual', 'provider-suggested'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `memberships_one_open_per_drive` ON `memberships` (`drive_id`) WHERE "memberships"."ended_at" IS NULL;--> statement-breakpoint
CREATE TABLE `pools` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`layout_label` text,
	`expected_members` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "pools_name_not_empty" CHECK(length("pools"."name") > 0),
	CONSTRAINT "pools_expected_members_min" CHECK("pools"."expected_members" IS NULL OR "pools"."expected_members" >= 1)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pools_name_unique` ON `pools` (`name`);--> statement-breakpoint
CREATE TABLE `provider_snapshot` (
	`id` integer PRIMARY KEY NOT NULL,
	`provider_id` text NOT NULL,
	`observations` text NOT NULL,
	`last_success_at` text,
	`last_attempt_at` text,
	`last_error` text,
	CONSTRAINT "provider_snapshot_singleton" CHECK("provider_snapshot"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE `slots` (
	`id` text PRIMARY KEY NOT NULL,
	`grid_id` text NOT NULL,
	`position` integer NOT NULL,
	`label` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`grid_id`) REFERENCES `grids`(`id`) ON UPDATE no action ON DELETE restrict,
	CONSTRAINT "slots_position_min" CHECK("slots"."position" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `slots_grid_position_unique` ON `slots` (`grid_id`,`position`);