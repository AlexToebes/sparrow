import { and, asc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import {
  addConflictInputSchema,
  type DriveConflictView,
  type PoolConflict,
  type SpareConflict,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { getGrid, getSlot } from '../db/layout-repo.js';
import { driveConflicts, drives, installations } from '../db/schema.js';
import {
  recordActivity,
  slotDisplayLabel,
  type DbTransaction,
  type EventInput,
  type Reader,
} from './activities.js';
import { findDrive, getDrive } from './drives.js';
import { conflict, invalid, notFound } from './errors.js';

// R78: drives that are not recommended together (same batch, same purchase, same failure history).
// A symmetric pair is stored once, with the lower drive id first. It is advice only: it never blocks an
// action, is computed on every read (pool cards, the spare picker) and is never stored as a verdict.
// Retired drives may be paired and keep their pairs, but they never cause a warning.
//
// Rule 6: adding or removing a pair is ONE activity (`conflict-added` / `conflict-removed`) of two
// atomic events, one per drive, each carrying the other drive, its serial as it was and the reason, so
// either can be applied or undone alone (core/replay.ts).

type ConflictRow = typeof driveConflicts.$inferSelect;

const nowIso = () => new Date().toISOString();

/** The canonical order of a pair: the lower id is `a`. */
export const orderedPair = (x: string, y: string): [string, string] => (x < y ? [x, y] : [y, x]);

/** The pair's stored row, or undefined. */
function findPair(db: Reader, x: string, y: string): ConflictRow | undefined {
  const [a, b] = orderedPair(x, y);
  return db
    .select()
    .from(driveConflicts)
    .where(and(eq(driveConflicts.driveAId, a), eq(driveConflicts.driveBId, b)))
    .get();
}

/** The two events of one pair: one per drive, each about that drive alone. */
function pairEvents(
  type: 'conflict-added' | 'conflict-removed',
  one: { id: string; serial: string },
  other: { id: string; serial: string },
  row: Pick<ConflictRow, 'reason' | 'createdAt'>,
): EventInput[] {
  // Either event alone says which pair it is (this event's drive plus the other one) and what to put
  // back; a removal also keeps when the pair was made, so undo restores the row exactly.
  const payload = (you: { id: string; serial: string }) => ({
    otherDriveId: you.id,
    otherSerial: you.serial,
    reason: row.reason,
    ...(type === 'conflict-removed' ? { createdAt: row.createdAt } : {}),
  });
  return [
    { type, driveId: one.id, payload: payload(other) },
    { type, driveId: other.id, payload: payload(one) },
  ];
}

/** Marks two drives as not recommended together. One activity, two events (one per drive). */
export function addConflict(db: AppDb, driveId: string, input: unknown): DriveConflictView {
  const { otherDriveId, reason } = addConflictInputSchema.parse(input);
  return db.transaction((tx) => {
    const drive = getDrive(tx, driveId);
    if (otherDriveId === driveId) throw invalid('A drive cannot be paired with itself');
    const other = getDrive(tx, otherDriveId);
    if (findPair(tx, driveId, otherDriveId)) {
      throw conflict(
        `${drive.serial} and ${other.serial} are already marked as not recommended together`,
        {
          driveId: other.id,
        },
      );
    }
    const at = nowIso();
    const [a, b] = orderedPair(driveId, otherDriveId);
    tx.insert(driveConflicts).values({ driveAId: a, driveBId: b, reason, createdAt: at }).run();
    recordActivity(tx, {
      kind: 'conflict-added',
      recordedAt: at,
      events: pairEvents('conflict-added', drive, other, { reason, createdAt: at }),
    });
    return viewOf(tx, driveId, { driveAId: a, driveBId: b, reason, createdAt: at });
  });
}

/** Takes a pair apart again. One activity, two events; the reason is kept in them so undo restores it. */
export function removeConflict(db: AppDb, driveId: string, otherDriveId: string): void {
  db.transaction((tx) => {
    const drive = getDrive(tx, driveId);
    const other = getDrive(tx, otherDriveId);
    const row = findPair(tx, driveId, otherDriveId);
    if (!row) {
      throw notFound(
        `${drive.serial} and ${other.serial} are not marked as not recommended together`,
      );
    }
    tx.delete(driveConflicts)
      .where(
        and(eq(driveConflicts.driveAId, row.driveAId), eq(driveConflicts.driveBId, row.driveBId)),
      )
      .run();
    recordActivity(tx, {
      kind: 'conflict-removed',
      events: pairEvents('conflict-removed', drive, other, row),
    });
  });
}

/** Where an installed drive sits: "Front bays, Bay 3". */
function whereIs(db: DbTransaction, slotId: string | null): string | null {
  if (slotId === null) return null;
  const slot = getSlot(db, slotId);
  if (!slot) return null;
  const grid = getGrid(db, slot.gridId);
  return [grid?.name, slotDisplayLabel(slot)].filter(Boolean).join(', ');
}

function viewOf(db: DbTransaction, driveId: string, row: ConflictRow): DriveConflictView {
  const otherId = row.driveAId === driveId ? row.driveBId : row.driveAId;
  const other = findDrive(db, otherId);
  if (!other) throw notFound(`Drive ${otherId} not found`);
  return {
    otherDriveId: other.id,
    serial: other.serial,
    model: other.model,
    capacityBytes: other.capacityBytes,
    status: other.status,
    where: whereIs(db, other.slotId),
    reason: row.reason,
    createdAt: row.createdAt,
  };
}

/** The pairs a drive is in, seen from that drive (the other drive's facts), ordered by serial. */
export function listDriveConflicts(appDb: AppDb, driveId: string): DriveConflictView[] {
  return appDb.transaction((db) => {
    getDrive(db, driveId); // 404 for an unknown drive
    return db
      .select()
      .from(driveConflicts)
      .where(or(eq(driveConflicts.driveAId, driveId), eq(driveConflicts.driveBId, driveId)))
      .all()
      .map((row) => viewOf(db, driveId, row))
      .sort((x, y) =>
        x.serial.localeCompare(y.serial, 'en', { numeric: true, sensitivity: 'base' }),
      );
  });
}

/**
 * Current members of a pool: the drives installed with that pool. Retired drives are left out (the
 * core never installs one, but "retired drives never cause a warning" is a rule of its own).
 */
function activeMembers(db: Reader, poolId: string, exceptDriveId?: string) {
  return db
    .select({ id: drives.id, serial: drives.serial, serialNormalized: drives.serialNormalized })
    .from(installations)
    .innerJoin(drives, eq(drives.id, installations.driveId))
    .where(
      and(
        eq(installations.poolId, poolId),
        isNull(drives.retirementReason),
        exceptDriveId ? ne(drives.id, exceptDriveId) : undefined,
      ),
    )
    .orderBy(asc(drives.serialNormalized))
    .all();
}

/** The stored pairs that touch any of the given drives. */
function pairsTouching(db: Reader, ids: string[]): ConflictRow[] {
  if (ids.length === 0) return [];
  return db
    .select()
    .from(driveConflicts)
    .where(or(inArray(driveConflicts.driveAId, ids), inArray(driveConflicts.driveBId, ids)))
    .all();
}

/** The ids among `ids` that are not retired. */
const activeIds = (db: Reader, ids: string[]): Set<string> =>
  ids.length === 0
    ? new Set()
    : new Set(
        db
          .select({ id: drives.id })
          .from(drives)
          .where(and(inArray(drives.id, ids), isNull(drives.retirementReason)))
          .all()
          .map((r) => r.id),
      );

/**
 * R78: pairs of CURRENT members of the pool that are not recommended together. Computed on every read.
 * Ordered by the pair's serials so the page does not jump.
 */
export function poolConflicts(db: Reader, poolId: string): PoolConflict[] {
  const members = activeMembers(db, poolId);
  const byId = new Map(members.map((m) => [m.id, m]));
  return pairsTouching(
    db,
    members.map((m) => m.id),
  )
    .filter((p) => byId.has(p.driveAId) && byId.has(p.driveBId))
    .map((p) => {
      const first = byId.get(p.driveAId)!;
      const second = byId.get(p.driveBId)!;
      const [x, y] =
        first.serialNormalized <= second.serialNormalized ? [first, second] : [second, first];
      return {
        driveAId: x.id,
        serialA: x.serial,
        driveBId: y.id,
        serialB: y.serial,
        reason: p.reason,
      };
    })
    .sort((p, q) => p.serialA.localeCompare(q.serialA) || p.serialB.localeCompare(q.serialB));
}

/**
 * R78, R12: for each given spare, the current members of the pool it is not recommended with. The drive
 * being replaced is left out (it is on its way out). Spares without a conflict are absent from the map.
 */
export function spareConflictsWithPool(
  db: Reader,
  poolId: string,
  spareIds: string[],
  outgoingDriveId?: string,
): Map<string, SpareConflict[]> {
  const result = new Map<string, SpareConflict[]>();
  const byId = new Map(activeMembers(db, poolId, outgoingDriveId).map((m) => [m.id, m]));
  const spares = activeIds(db, spareIds);
  for (const p of pairsTouching(db, [...spares])) {
    for (const [spareId, memberId] of [
      [p.driveAId, p.driveBId],
      [p.driveBId, p.driveAId],
    ] as const) {
      const member = byId.get(memberId);
      if (!member || !spares.has(spareId)) continue;
      result.set(spareId, [
        ...(result.get(spareId) ?? []),
        { driveId: member.id, serial: member.serial, reason: p.reason },
      ]);
    }
  }
  for (const list of result.values()) list.sort((x, y) => x.serial.localeCompare(y.serial));
  return result;
}
