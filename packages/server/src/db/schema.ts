import { sql, type SQL } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import {
  DRIVE_CONDITIONS,
  DRIVE_LINK_ROLES,
  DRIVE_STATUSES,
  DRIVE_TYPES,
  EVENT_TYPES,
  GRID_ORIENTATIONS,
  MEMBERSHIP_ROLES,
  MEMBERSHIP_SOURCES,
  RETIREMENT_REASONS,
  SLOT_LINK_ROLES,
} from '@sparrow/shared';
import type { Observation } from '@sparrow/shared';

const inList = (column: string, values: readonly string[]): SQL =>
  sql.raw(`${column} IN (${values.map((v) => `'${v}'`).join(', ')})`);

const inListOrNull = (column: string, values: readonly string[]): SQL =>
  sql.raw(`${column} IS NULL OR ${column} IN (${values.map((v) => `'${v}'`).join(', ')})`);

export const enclosures = sqliteTable(
  'enclosures',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [check('enclosures_name_not_empty', sql`length(${t.name}) > 0`)],
);

export const grids = sqliteTable(
  'grids',
  {
    id: text('id').primaryKey(),
    enclosureId: text('enclosure_id')
      .notNull()
      .references(() => enclosures.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    rows: integer('rows').notNull(),
    columns: integer('columns').notNull(),
    orientation: text('orientation', { enum: GRID_ORIENTATIONS }).notNull(),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('grids_enclosure_name_unique').on(t.enclosureId, t.name),
    check('grids_name_not_empty', sql`length(${t.name}) > 0`),
    check('grids_rows_min', sql`${t.rows} >= 1`),
    check('grids_columns_min', sql`${t.columns} >= 1`),
    check('grids_orientation_enum', inList('orientation', GRID_ORIENTATIONS)),
  ],
);

export const slots = sqliteTable(
  'slots',
  {
    id: text('id').primaryKey(),
    gridId: text('grid_id')
      .notNull()
      .references(() => grids.id, { onDelete: 'restrict' }),
    position: integer('position').notNull(),
    label: text('label'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('slots_grid_position_unique').on(t.gridId, t.position),
    check('slots_position_min', sql`${t.position} >= 0`),
  ],
);

export const drives = sqliteTable(
  'drives',
  {
    id: text('id').primaryKey(),
    serial: text('serial').notNull(),
    serialNormalized: text('serial_normalized').notNull(),
    // Drive identifier used only as the R2 fallback match; filled from an observation (Step 6).
    wwn: text('wwn'),
    model: text('model'),
    capacityBytes: integer('capacity_bytes'),
    driveType: text('drive_type', { enum: DRIVE_TYPES }),
    formFactor: text('form_factor'),
    storageLocation: text('storage_location'),
    condition: text('condition', { enum: DRIVE_CONDITIONS }),
    lastTestDate: text('last_test_date'),
    purchaseDate: text('purchase_date'),
    warrantyExpiry: text('warranty_expiry'),
    vendor: text('vendor'),
    notes: text('notes'),
    status: text('status', { enum: DRIVE_STATUSES }).notNull(),
    slotId: text('slot_id').references(() => slots.id, { onDelete: 'restrict' }),
    retirementReason: text('retirement_reason', { enum: RETIREMENT_REASONS }),
    retirementDate: text('retirement_date'),
    retirementNote: text('retirement_note'),
    // R68: calendar date (YYYY-MM-DD) the drive went into its slot; only while installed. NULL on an
    // installed drive = "installation date not recorded".
    installedOn: text('installed_on'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('drives_serial_normalized_unique').on(t.serialNormalized), // D6
    uniqueIndex('drives_slot_id_unique').on(t.slotId), // D7
    check('drives_slot_only_when_installed', sql`${t.slotId} IS NULL OR ${t.status} = 'installed'`),
    check(
      'drives_installed_needs_slot',
      sql`${t.status} <> 'installed' OR ${t.slotId} IS NOT NULL`,
    ),
    check(
      'drives_installed_on_only_when_installed',
      sql`${t.installedOn} IS NULL OR ${t.status} = 'installed'`,
    ),
    check(
      'drives_retired_needs_reason',
      sql`${t.status} <> 'retired' OR ${t.retirementReason} IS NOT NULL`,
    ),
    check('drives_drive_type_enum', inListOrNull('drive_type', DRIVE_TYPES)),
    check('drives_status_enum', inList('status', DRIVE_STATUSES)),
    check('drives_condition_enum', inListOrNull('condition', DRIVE_CONDITIONS)),
    check('drives_retirement_reason_enum', inListOrNull('retirement_reason', RETIREMENT_REASONS)),
  ],
);

export const pools = sqliteTable(
  'pools',
  {
    id: text('id').primaryKey(),
    name: text('name').notNull(),
    layoutLabel: text('layout_label'),
    expectedMembers: integer('expected_members'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('pools_name_unique').on(t.name),
    check('pools_name_not_empty', sql`length(${t.name}) > 0`),
    check(
      'pools_expected_members_min',
      sql`${t.expectedMembers} IS NULL OR ${t.expectedMembers} >= 1`,
    ),
  ],
);

export const memberships = sqliteTable(
  'memberships',
  {
    id: text('id').primaryKey(),
    driveId: text('drive_id')
      .notNull()
      .references(() => drives.id),
    poolId: text('pool_id')
      .notNull()
      .references(() => pools.id),
    role: text('role', { enum: MEMBERSHIP_ROLES }).notNull(),
    source: text('source', { enum: MEMBERSHIP_SOURCES }).notNull(),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('memberships_one_open_per_drive')
      .on(t.driveId)
      .where(sql`${t.endedAt} IS NULL`),
    check(
      'memberships_ended_after_started',
      sql`${t.endedAt} IS NULL OR ${t.endedAt} >= ${t.startedAt}`,
    ),
    check('memberships_role_enum', inList('role', MEMBERSHIP_ROLES)),
    check('memberships_source_enum', inList('source', MEMBERSHIP_SOURCES)),
  ],
);

// One event per real action (R14). Which drives, slots and pools it involves lives in the link
// tables below, not in the payload, so histories read through indexed joins.
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    type: text('type', { enum: EVENT_TYPES }).notNull(),
    at: text('at').notNull(),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  },
  (t) => [index('events_at_idx').on(t.at), check('events_type_enum', inList('type', EVENT_TYPES))],
);

// Drives are never deleted (D5), so this link has a real foreign key.
export const eventDrives = sqliteTable(
  'event_drives',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    driveId: text('drive_id')
      .notNull()
      .references(() => drives.id),
    role: text('role', { enum: DRIVE_LINK_ROLES }).notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.driveId] }),
    index('event_drives_drive_idx').on(t.driveId, t.eventId),
    check('event_drives_role_enum', inList('role', DRIVE_LINK_ROLES)),
  ],
);

// No foreign key on slot_id: deleting a grid must not erase the history of its bays. The label and
// grid are copied as they were when the event was written (R39).
export const eventSlots = sqliteTable(
  'event_slots',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    slotId: text('slot_id').notNull(),
    role: text('role', { enum: SLOT_LINK_ROLES }).notNull(),
    slotLabel: text('slot_label'),
    gridId: text('grid_id').notNull(),
    gridName: text('grid_name').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.slotId, t.role] }),
    index('event_slots_slot_idx').on(t.slotId, t.eventId),
    check('event_slots_role_enum', inList('role', SLOT_LINK_ROLES)),
  ],
);

// No foreign key on pool_id: an unused pool can be deleted and its history stays readable.
export const eventPools = sqliteTable(
  'event_pools',
  {
    eventId: text('event_id')
      .notNull()
      .references(() => events.id, { onDelete: 'cascade' }),
    poolId: text('pool_id').notNull(),
    poolName: text('pool_name').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.eventId, t.poolId] }),
    index('event_pools_pool_idx').on(t.poolId, t.eventId),
  ],
);

// One-time flags such as "layout seeded" (Step 2).
export const appMeta = sqliteTable('app_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// Single-row cache of the last provider snapshot (Step 4, R18, R55).
export const providerSnapshot = sqliteTable(
  'provider_snapshot',
  {
    id: integer('id').primaryKey(),
    providerId: text('provider_id').notNull(),
    observations: text('observations', { mode: 'json' }).$type<Observation[]>().notNull(),
    lastSuccessAt: text('last_success_at'),
    lastAttemptAt: text('last_attempt_at'),
    lastError: text('last_error'),
  },
  (t) => [check('provider_snapshot_singleton', sql`${t.id} = 1`)],
);
