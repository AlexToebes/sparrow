CREATE TABLE `activities` (
	`id` text PRIMARY KEY NOT NULL,
	`seq` integer NOT NULL,
	`kind` text NOT NULL,
	`recorded_at` text NOT NULL,
	`occurred_on` text,
	`note` text,
	CONSTRAINT "activities_kind_enum" CHECK(kind IN ('drive-added', 'discovered-created', 'discovered-linked', 'retired-imported', 'drive-edited', 'suggestions-applied', 'suggestions-dismissed', 'suggestions-restored', 'assigned', 'replaced', 'removed', 'retired', 'sent-for-rma', 'reinstated', 'moved', 'swapped', 'pool-joined', 'pool-left', 'pool-role-changed', 'pool-changed', 'health-polled', 'layout-updated', 'pool-edited'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `activities_seq_unique` ON `activities` (`seq`);--> statement-breakpoint
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
	`retirement_reason` text,
	`retirement_date` text,
	`retirement_note` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "drives_retirement_fields_need_reason" CHECK("drives"."retirement_reason" IS NOT NULL OR ("drives"."retirement_date" IS NULL AND "drives"."retirement_note" IS NULL)),
	CONSTRAINT "drives_drive_type_enum" CHECK(drive_type IS NULL OR drive_type IN ('HDD', 'SSD', 'NVMe')),
	CONSTRAINT "drives_condition_enum" CHECK(condition IS NULL OR condition IN ('new', 'used', 'tested')),
	CONSTRAINT "drives_retirement_reason_enum" CHECK(retirement_reason IS NULL OR retirement_reason IN ('failed', 'replaced', 'other'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `drives_serial_normalized_unique` ON `drives` (`serial_normalized`);--> statement-breakpoint
CREATE TABLE `enclosures` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	CONSTRAINT "enclosures_name_not_empty" CHECK(length("enclosures"."name") > 0)
);
--> statement-breakpoint
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
	CONSTRAINT "events_type_enum" CHECK(type IN ('drive-created', 'drive-updated', 'drive-linked', 'drive-installed', 'drive-uninstalled', 'installation-updated', 'pool-joined', 'pool-left', 'pool-role-changed', 'drive-retired', 'drive-sent-for-rma', 'drive-reinstated', 'health-changed', 'suggestion-dismissed', 'enclosure-created', 'enclosure-renamed', 'enclosure-deleted', 'grid-created', 'grid-updated', 'grid-deleted', 'slot-relabeled', 'pool-created', 'pool-updated', 'pool-deleted'))
);
--> statement-breakpoint
CREATE INDEX `events_drive_idx` ON `events` (`drive_id`);--> statement-breakpoint
CREATE INDEX `events_slot_idx` ON `events` (`slot_id`);--> statement-breakpoint
CREATE INDEX `events_pool_idx` ON `events` (`pool_id`);--> statement-breakpoint
CREATE INDEX `events_activity_ord_idx` ON `events` (`activity_id`,`ord`);--> statement-breakpoint
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
CREATE TABLE `installations` (
	`drive_id` text PRIMARY KEY NOT NULL,
	`slot_id` text NOT NULL,
	`pool_id` text,
	`pool_role` text,
	`installed_on` text,
	FOREIGN KEY (`drive_id`) REFERENCES `drives`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`slot_id`) REFERENCES `slots`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`pool_id`) REFERENCES `pools`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "installations_pool_and_role_together" CHECK(("installations"."pool_id" IS NULL) = ("installations"."pool_role" IS NULL)),
	CONSTRAINT "installations_pool_role_enum" CHECK(pool_role IS NULL OR pool_role IN ('data', 'hot-spare'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `installations_slot_id_unique` ON `installations` (`slot_id`);--> statement-breakpoint
CREATE INDEX `installations_pool_idx` ON `installations` (`pool_id`);--> statement-breakpoint
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
--> statement-breakpoint
CREATE TRIGGER `installations_drive_not_retired` BEFORE INSERT ON `installations`
WHEN (SELECT `retirement_reason` FROM `drives` WHERE `id` = NEW.`drive_id`) IS NOT NULL
BEGIN
	SELECT RAISE(ABORT, 'a retired drive cannot be installed');
END;
