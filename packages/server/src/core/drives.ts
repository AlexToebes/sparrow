import { randomUUID } from 'node:crypto';
import { and, eq, ne } from 'drizzle-orm';
import {
  createDriveInputSchema,
  normalizeSerial,
  updateDriveInputSchema,
  type Drive,
  type DriveStatus,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { drives, memberships } from '../db/schema.js';
import { conflict, notFound } from './errors.js';
import { parseInstalledOn, startOfInstalledOn } from './installed-on.js';
import { openMembership } from './memberships.js';
import { recordEvent, type DbTransaction } from './events.js';

// Drive records are never hard-deleted (D5): there is deliberately no delete function here.
// Status, slot and retirement fields change only through lifecycle actions (Step 7), not this service.

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
      `Serial ${holder.serial} is already used by drive ${holder.id} (${holder.status})`,
      { driveId: holder.id },
    );
  }
}

/** Creates a spare (R21). Serial is required; every other R11 field is optional. Logs drive-created (R14). */
export function createDrive(
  db: AppDb,
  input: unknown,
  /** Not part of the public input schema: the WWN only ever comes from an observation (R2). */
  internal: { wwn?: string | null | undefined } = {},
): Drive {
  const wwn = internal.wwn?.trim() || null;
  const parsed = createDriveInputSchema.parse(input);
  const serialNormalized = normalizeSerial(parsed.serial);
  const initial = {
    serial: parsed.serial,
    ...(wwn === null ? {} : { wwn }),
    ...Object.fromEntries(EDITABLE_FIELDS.map((f) => [f, parsed[f] ?? null])),
  };
  return db.transaction((tx) => {
    assertSerialFree(tx, serialNormalized);
    const now = new Date().toISOString();
    const row = tx
      .insert(drives)
      .values({
        ...initial,
        id: randomUUID(),
        serialNormalized,
        wwn,
        status: 'spare' satisfies DriveStatus,
        slotId: null,
        retirementReason: null,
        retirementDate: null,
        replacedByDriveId: null,
        retirementNote: null,
        installedOn: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    recordEvent(tx, { driveId: row.id, type: 'drive-created', payload: initial });
    return row;
  });
}

/**
 * Edits R11 fields. Only fields whose value actually changes are written and logged as
 * `{ changes: { field: { from, to } } }`. A patch that changes nothing writes no event.
 * The drive update and its event share one transaction, so a failed event write rolls back the edit.
 */
export function updateDrive(db: AppDb, id: string, input: unknown): Drive {
  const patch = updateDriveInputSchema.parse(input);
  return db.transaction((tx) => {
    const current = tx.select().from(drives).where(eq(drives.id, id)).get();
    if (!current) throw notFound(`Drive ${id} not found`);

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

    let membershipStartedAt: { from: string; to: string } | undefined;
    if (patch.installedOn !== undefined && patch.installedOn !== current.installedOn) {
      // R68: only while installed; leaving the slot clears the date (history keeps it in events).
      if (current.status !== 'installed') {
        throw conflict(
          `Drive ${id} is ${current.status}; the installation date can only be set while it is installed`,
        );
      }
      const clock = new Date();
      const to = patch.installedOn === null ? null : parseInstalledOn(patch.installedOn, clock);
      changes.installedOn = { from: current.installedOn, to };
      values.installedOn = to;
      // The open membership started with the install; keep it in step unless it was edited apart.
      const open = openMembership(tx, id);
      // Only when both dates are known; with an unrecorded side the membership is left untouched.
      if (
        open &&
        to !== null &&
        current.installedOn !== null &&
        open.startedAt.slice(0, 10) === current.installedOn
      ) {
        const start = startOfInstalledOn(to, clock);
        tx.update(memberships)
          .set({ startedAt: start.startedAt })
          .where(eq(memberships.id, open.id))
          .run();
        membershipStartedAt = { from: open.startedAt, to: start.startedAt };
      }
    }

    for (const field of EDITABLE_FIELDS as readonly EditableField[]) {
      const to = patch[field];
      if (to === undefined) continue;
      const next = to ?? null;
      if (next === current[field]) continue;
      changes[field] = { from: current[field], to: next };
      values[field] = next;
    }

    if (Object.keys(changes).length === 0) return current;

    const updated = tx
      .update(drives)
      .set({ ...values, updatedAt: new Date().toISOString() })
      .where(eq(drives.id, id))
      .returning()
      .get();
    recordEvent(tx, {
      driveId: id,
      type: 'drive-updated',
      payload: { changes, ...(membershipStartedAt ? { membershipStartedAt } : {}) },
    });
    return updated;
  });
}

/** Lists drives by serial, optionally filtered by status (R3). */
export function listDrives(db: AppDb, filter: { status?: DriveStatus } = {}): Drive[] {
  const query = db.select().from(drives);
  const filtered = filter.status ? query.where(eq(drives.status, filter.status)) : query;
  return filtered.orderBy(drives.serialNormalized).all();
}

export function getDrive(db: AppDb, id: string): Drive {
  const row = db.select().from(drives).where(eq(drives.id, id)).get();
  if (!row) throw notFound(`Drive ${id} not found`);
  return row;
}
