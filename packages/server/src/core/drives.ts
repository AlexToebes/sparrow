import { randomUUID } from 'node:crypto';
import { and, eq, getTableColumns, ne } from 'drizzle-orm';
import {
  createDriveInputSchema,
  normalizeSerial,
  updateDriveInputSchema,
  type Drive,
  type DriveStatus,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { drives, installations } from '../db/schema.js';
import { recordActivity, type DbTransaction, type EventInput, type Reader } from './activities.js';
import { conflict, notFound } from './errors.js';
import { parseInstalledOn } from './installed-on.js';

// Drive records are never hard-deleted (D5): there is deliberately no delete function here.
// A drive row holds what the drive IS. Where it sits, since when and in which pool is its installation
// (core/installations.ts); the status is computed: retired iff it has a retirement reason, else
// installed iff it has an installation, else spare (R13). Retirement and installation happen only
// through lifecycle actions (assignment.ts, move.ts), not through this service.

const installationColumns = {
  slotId: installations.slotId,
  installedOn: installations.installedOn,
  poolId: installations.poolId,
  poolRole: installations.poolRole,
};
const driveColumns = { ...getTableColumns(drives), ...installationColumns };
type DriveRow = typeof drives.$inferSelect;
type DriveJoinRow = DriveRow & {
  slotId: string | null;
  installedOn: string | null;
  poolId: string | null;
  poolRole: Drive['poolRole'];
};

/** The status of a drive, computed from its record and whether it has an installation (R13). */
export const driveStatusOf = (
  retirementReason: string | null,
  slotId: string | null,
): DriveStatus => (retirementReason !== null ? 'retired' : slotId !== null ? 'installed' : 'spare');

function toDrive(row: DriveJoinRow): Drive {
  return { ...row, status: driveStatusOf(row.retirementReason, row.slotId) };
}

const selectJoined = (db: Reader) =>
  db
    .select(driveColumns)
    .from(drives)
    .leftJoin(installations, eq(installations.driveId, drives.id));

/** Every drive with its computed status and installation fields, ordered by normalized serial. */
export function listDrives(db: Reader, filter: { status?: DriveStatus } = {}): Drive[] {
  const all = selectJoined(db).orderBy(drives.serialNormalized).all().map(toDrive);
  return filter.status ? all.filter((d) => d.status === filter.status) : all;
}

/** One drive as the API shows it, or undefined. */
export function findDrive(db: Reader, id: string): Drive | undefined {
  const row = selectJoined(db).where(eq(drives.id, id)).get();
  return row ? toDrive(row) : undefined;
}

export function getDrive(db: Reader, id: string): Drive {
  const drive = findDrive(db, id);
  if (!drive) throw notFound(`Drive ${id} not found`);
  return drive;
}

/** The drive in a bay, if any. */
export function driveInSlot(db: Reader, slotId: string): Drive | undefined {
  const row = selectJoined(db).where(eq(installations.slotId, slotId)).get();
  return row ? toDrive(row) : undefined;
}

/** The R11 fields that create and edit may set. */
const EDITABLE_FIELDS = [
  'model',
  'capacityBytes',
  'driveType',
  'formFactor',
  'storageLocation',
  'condition',
  'lastTestDate',
  'purchaseDate',
  'warrantyExpiry',
  'vendor',
  'notes',
] as const;

type EditableField = (typeof EDITABLE_FIELDS)[number];

/** D6: fail with a conflict naming the holder of the serial. The unique index remains the backstop. */
function assertSerialFree(
  tx: DbTransaction,
  serialNormalized: string,
  exceptDriveId?: string,
): void {
  const where =
    exceptDriveId === undefined
      ? eq(drives.serialNormalized, serialNormalized)
      : and(eq(drives.serialNormalized, serialNormalized), ne(drives.id, exceptDriveId));
  const holder = tx.select().from(drives).where(where).get();
  if (holder) {
    throw conflict(
      `Serial ${holder.serial} is already used by drive ${holder.id} (${getDrive(tx, holder.id).status})`,
      { driveId: holder.id },
    );
  }
}

/**
 * Creates a spare record (R21) inside the caller's transaction and appends its drive-created event
 * (the whole record, so the log can rebuild it) to `evs`. The caller records the activity.
 */
export function insertDrive(
  tx: DbTransaction,
  input: unknown,
  /** Not part of the public input schema: the WWN only ever comes from an observation (R2). */
  internal: { wwn?: string | null | undefined },
  evs: EventInput[],
): Drive {
  const wwn = internal.wwn?.trim() || null;
  const parsed = createDriveInputSchema.parse(input);
  const serialNormalized = normalizeSerial(parsed.serial);
  assertSerialFree(tx, serialNormalized);
  const now = new Date().toISOString();
  const row = tx
    .insert(drives)
    .values({
      id: randomUUID(),
      serial: parsed.serial,
      serialNormalized,
      wwn,
      ...Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, parsed[f] ?? null])),
      retirementReason: null,
      retirementDate: null,
      retirementNote: null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .get();
  evs.push({ type: 'drive-created', driveId: row.id, payload: { ...row } });
  return getDrive(tx, row.id);
}

/** Creates a spare (R21). Serial is required; every other R11 field is optional. Logs a `drive-added` activity (R14). */
export function createDrive(
  db: AppDb,
  input: unknown,
  internal: { wwn?: string | null | undefined } = {},
): Drive {
  // Validate before opening a transaction so a bad request never touches the log.
  createDriveInputSchema.parse(input);
  return db.transaction((tx) => {
    const evs: EventInput[] = [];
    const drive = insertDrive(tx, input, internal, evs);
    recordActivity(tx, { kind: 'drive-added', events: evs });
    return drive;
  });
}

/**
 * Edits R11 fields inside the caller's transaction. Only fields whose value actually changes are
 * written and logged as `{ changes: { field: { from, to } } }`; a change of the installation date
 * (R68) is a separate `installation-updated` event, because it belongs to the installation. A patch
 * that changes nothing appends no event.
 */
export function applyDriveUpdate(
  tx: DbTransaction,
  id: string,
  input: unknown,
  /** `source: 'provider'` marks edits applied from accepted provider suggestions (R72). */
  opts: { source?: 'provider' },
  evs: EventInput[],
): Drive {
  const patch = updateDriveInputSchema.parse(input);
  const current = tx.select().from(drives).where(eq(drives.id, id)).get();
  if (!current) throw notFound(`Drive ${id} not found`);
  const view = getDrive(tx, id);

  const values: Record<string, unknown> = {};
  const changes: Record<string, { from: unknown; to: unknown }> = {};

  if (patch.serial !== undefined && patch.serial !== current.serial) {
    changes.serial = { from: current.serial, to: patch.serial };
    values.serial = patch.serial;
    const serialNormalized = normalizeSerial(patch.serial);
    if (serialNormalized !== current.serialNormalized) {
      assertSerialFree(tx, serialNormalized, id);
    }
    values.serialNormalized = serialNormalized;
  }

  if (patch.wwn !== undefined) {
    const next = patch.wwn;
    if (next !== current.wwn) {
      if (next !== null) {
        const wanted = next.toLowerCase();
        const holder = tx
          .select()
          .from(drives)
          .all()
          .find((d) => d.id !== id && d.wwn?.trim().toLowerCase() === wanted);
        if (holder) {
          throw conflict(`WWN ${next} is already held by drive ${holder.serial} (${holder.id})`, {
            driveId: holder.id,
          });
        }
      }
      changes.wwn = { from: current.wwn, to: next };
      values.wwn = next;
    }
  }

  let installationChange: { from: string | null; to: string | null } | undefined;
  if (patch.installedOn !== undefined && patch.installedOn !== view.installedOn) {
    // R68: only while installed; leaving the bay deletes the installation, the log keeps the date.
    if (view.status !== 'installed') {
      throw conflict(
        `Drive ${id} is ${view.status}; the installation date can only be set while it is installed`,
      );
    }
    const to = patch.installedOn === null ? null : parseInstalledOn(patch.installedOn);
    installationChange = { from: view.installedOn, to };
  }

  for (const field of EDITABLE_FIELDS as readonly EditableField[]) {
    const to = patch[field];
    if (to === undefined) continue;
    const next = to ?? null;
    if (next === current[field]) continue;
    changes[field] = { from: current[field], to: next };
    values[field] = next;
  }

  if (Object.keys(changes).length > 0) {
    tx.update(drives)
      .set({ ...values, updatedAt: new Date().toISOString() })
      .where(eq(drives.id, id))
      .run();
    evs.push({
      type: 'drive-updated',
      driveId: id,
      payload: { changes, ...(opts.source ? { source: opts.source } : {}) },
    });
  }
  if (installationChange) {
    tx.update(installations)
      .set({ installedOn: installationChange.to })
      .where(eq(installations.driveId, id))
      .run();
    evs.push({
      type: 'installation-updated',
      driveId: id,
      slotId: view.slotId,
      payload: { changes: { installedOn: installationChange } },
    });
  }
  return getDrive(tx, id);
}

/**
 * Edits a drive (R11, R68). One `drive-edited` activity holds the drive-updated and/or
 * installation-updated events; with `source: 'provider'` it is a `suggestions-applied` activity
 * (R72). A patch that changes nothing writes no activity.
 */
export function updateDrive(
  db: AppDb,
  id: string,
  input: unknown,
  opts: { source?: 'provider' } = {},
): Drive {
  updateDriveInputSchema.parse(input);
  return db.transaction((tx) => {
    const evs: EventInput[] = [];
    const drive = applyDriveUpdate(tx, id, input, opts, evs);
    if (evs.length > 0) {
      recordActivity(tx, {
        kind: opts.source ? 'suggestions-applied' : 'drive-edited',
        events: evs,
      });
    }
    return drive;
  });
}
