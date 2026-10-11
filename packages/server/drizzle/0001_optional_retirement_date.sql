PRAGMA defer_foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__drives_copy` AS SELECT "id", "serial", "serial_normalized", "wwn", "model", "capacity_bytes", "drive_type", "form_factor", "storage_location", "condition", "last_test_date", "purchase_date", "warranty_expiry", "vendor", "notes", "status", "slot_id", "retirement_reason", "retirement_date", "replaced_by_drive_id", "retirement_note", "installed_on", "created_at", "updated_at" FROM `drives`;--> statement-breakpoint
DROP TABLE `drives`;--> statement-breakpoint
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
	`replaced_by_drive_id` text,
	`retirement_note` text,
	`installed_on` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`slot_id`) REFERENCES `slots`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`replaced_by_drive_id`) REFERENCES `drives`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "drives_slot_only_when_installed" CHECK("drives"."slot_id" IS NULL OR "drives"."status" = 'installed'),
	CONSTRAINT "drives_installed_needs_slot" CHECK("drives"."status" <> 'installed' OR "drives"."slot_id" IS NOT NULL),
	CONSTRAINT "drives_installed_on_only_when_installed" CHECK("drives"."installed_on" IS NULL OR "drives"."status" = 'installed'),
	CONSTRAINT "drives_retired_needs_reason" CHECK("drives"."status" <> 'retired' OR "drives"."retirement_reason" IS NOT NULL),
	CONSTRAINT "drives_not_replaced_by_self" CHECK("drives"."replaced_by_drive_id" IS NULL OR "drives"."replaced_by_drive_id" <> "drives"."id"),
	CONSTRAINT "drives_drive_type_enum" CHECK(drive_type IS NULL OR drive_type IN ('HDD', 'SSD', 'NVMe')),
	CONSTRAINT "drives_status_enum" CHECK(status IN ('spare', 'installed', 'retired')),
	CONSTRAINT "drives_condition_enum" CHECK(condition IS NULL OR condition IN ('new', 'used', 'tested')),
	CONSTRAINT "drives_retirement_reason_enum" CHECK(retirement_reason IS NULL OR retirement_reason IN ('failed', 'replaced', 'other'))
);
--> statement-breakpoint
INSERT INTO `drives`("id", "serial", "serial_normalized", "wwn", "model", "capacity_bytes", "drive_type", "form_factor", "storage_location", "condition", "last_test_date", "purchase_date", "warranty_expiry", "vendor", "notes", "status", "slot_id", "retirement_reason", "retirement_date", "replaced_by_drive_id", "retirement_note", "installed_on", "created_at", "updated_at") SELECT "id", "serial", "serial_normalized", "wwn", "model", "capacity_bytes", "drive_type", "form_factor", "storage_location", "condition", "last_test_date", "purchase_date", "warranty_expiry", "vendor", "notes", "status", "slot_id", "retirement_reason", "retirement_date", "replaced_by_drive_id", "retirement_note", "installed_on", "created_at", "updated_at" FROM `__drives_copy`;--> statement-breakpoint
DROP TABLE `__drives_copy`;--> statement-breakpoint
CREATE UNIQUE INDEX `drives_serial_normalized_unique` ON `drives` (`serial_normalized`);--> statement-breakpoint
CREATE UNIQUE INDEX `drives_slot_id_unique` ON `drives` (`slot_id`);
