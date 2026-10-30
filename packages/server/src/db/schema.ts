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
  ACTIVITY_KINDS,
  DRIVE_CONDITIONS,
  DRIVE_TYPES,
  EVENT_TYPES,
  GRID_ORIENTATIONS,
  MEMBERSHIP_ROLES,
  RETIREMENT_REASONS,
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

// A drive row holds what the drive IS: identity, specification, purchase and retirement. Where it
// sits and in which pool is the installation (below), and the status is derived: retired iff there is
// a retirement reason, else installed iff there is an installation, else spare (R13).
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
    retirementReason: text('retirement_reason', { enum: RETIREMENT_REASONS }),
    retirementDate: text('retirement_date'),
    retirementNote: text('retirement_note'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [
    uniqueIndex('drives_serial_normalized_unique').on(t.serialNormalized), // D6
    check(
      'drives_retirement_fields_need_reason',
      sql`${t.retirementReason} IS NOT NULL OR (${t.retirementDate} IS NULL AND ${t.retirementNote} IS NULL)`,
    ),
    check('drives_drive_type_enum', inListOrNull('drive_type', DRIVE_TYPES)),
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

// R29, D7: a drive installed in a bay. The pool and the pool role are properties of this relationship.
// The drive is the key and the bay is UNIQUE: a drive sits in at most one bay and a bay holds at most one
// drive, so a drive is in at most one pool. Removing the drive deletes the row; the history lives in the activity
// log. A retired drive may not be installed: the core refuses it, and a BEFORE INSERT trigger in the
// baseline SQL backs that up (drizzle's snapshot does not track triggers).
export const installations = sqliteTable(
  'installations',
  {
    driveId: text('drive_id')
      .primaryKey()
      .references(() => drives.id),
    slotId: text('slot_id')
      .notNull()
      .references(() => slots.id, { onDelete: 'restrict' }),
    poolId: text('pool_id').references(() => pools.id),
    poolRole: text('pool_role', { enum: MEMBERSHIP_ROLES }),
    // R68: calendar date (YYYY-MM-DD) the drive went into the bay; NULL = "not recorded".
    installedOn: text('installed_on'),
  },
  (t) => [
    uniqueIndex('installations_slot_id_unique').on(t.slotId), // D7
    index('installations_pool_idx').on(t.poolId),
    check(
      'installations_pool_and_role_together',
      sql`(${t.poolId} IS NULL) = (${t.poolRole} IS NULL)`,
    ),
    check('installations_pool_role_enum', inListOrNull('pool_role', MEMBERSHIP_ROLES)),
  ],
);

// R78: two drives that are not recommended together (same batch, same purchase...). A symmetric pair is
// stored ONCE in canonical order (drive_a_id < drive_b_id), so a pair cannot exist twice and a drive
// cannot conflict with itself. It is the current situation only; adding and removing pairs is in the
// activity log. Drives are never deleted (D5), hence RESTRICT. Retired drives keep their pairs; the
// advice simply ignores them.
export const driveConflicts = sqliteTable(
  'drive_conflicts',
  {
    driveAId: text('drive_a_id')
      .notNull()
      .references(() => drives.id, { onDelete: 'restrict' }),
    driveBId: text('drive_b_id')
      .notNull()
      .references(() => drives.id, { onDelete: 'restrict' }),
    reason: text('reason'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.driveAId, t.driveBId] }),
    index('drive_conflicts_drive_b_idx').on(t.driveBId),
    check('drive_conflicts_ordered', sql`${t.driveAId} < ${t.driveBId}`),
    check(
      'drive_conflicts_reason_length',
      sql`${t.reason} IS NULL OR (length(${t.reason}) >= 1 AND length(${t.reason}) <= 200)`,
    ),
  ],
);

// R14: the history. An ACTIVITY is one user (or system) action; its EVENTS are the atomic facts that
// happened together. `seq` is the monotonic position in the log: every ordering uses it, never the
// timestamps. Activities are written only through core/activities.ts#recordActivity.
export const activities = sqliteTable(
  'activities',
  {
    id: text('id').primaryKey(),
    seq: integer('seq').notNull(),
    kind: text('kind', { enum: ACTIVITY_KINDS }).notNull(),
    recordedAt: text('recorded_at').notNull(),
    // The user's date for the action (installation, removal, retirement); NULL = not recorded / n.a.
    occurredOn: text('occurred_on'),
    note: text('note'),
  },
  (t) => [
    uniqueIndex('activities_seq_unique').on(t.seq),
    check('activities_kind_enum', inList('kind', ACTIVITY_KINDS)),
  ],
);

// One atomic fact about at most one drive, one slot and one pool. Drives are never deleted (D5), so
// drive_id has a real foreign key. slot_id and pool_id have none: deleting a grid or an unused pool
// must not erase history, so the bay's label and grid and the pool's name are copied here (R39).
export const events = sqliteTable(
  'events',
  {
    id: text('id').primaryKey(),
    activityId: text('activity_id')
      .notNull()
      .references(() => activities.id, { onDelete: 'cascade' }),
    ord: integer('ord').notNull(),
    type: text('type', { enum: EVENT_TYPES }).notNull(),
    driveId: text('drive_id').references(() => drives.id),
    slotId: text('slot_id'),
    slotLabel: text('slot_label'),
    gridId: text('grid_id'),
    gridName: text('grid_name'),
    poolId: text('pool_id'),
    poolName: text('pool_name'),
    payload: text('payload', { mode: 'json' }).$type<Record<string, unknown>>().notNull(),
  },
  (t) => [
    index('events_drive_idx').on(t.driveId),
    index('events_slot_idx').on(t.slotId),
    index('events_pool_idx').on(t.poolId),
    index('events_activity_ord_idx').on(t.activityId, t.ord),
    check('events_type_enum', inList('type', EVENT_TYPES)),
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
