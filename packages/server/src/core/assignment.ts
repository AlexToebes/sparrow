import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import type {
  AssignmentDefaults,
  Drive,
  MembershipRole,
  OccupantResolution,
  RetirementReason,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { getGrid, getSlot } from '../db/layout-repo.js';
import { drives, events, memberships, pools } from '../db/schema.js';
import { conflict, invalid, notFound } from './errors.js';
import { recordEvent, type DbTransaction } from './events.js';

// Slot assignment and retirement (R8, R35, R37, R60, R61, R62, D7). Every public function runs in
// ONE transaction and writes its events through recordEvent in that same transaction (R14), so a
// failure at any point leaves no partial state. D7 (one drive per slot, one slot per drive) is
// enforced by the unique index on drives.slot_id plus the status/slot CHECKs; the checks here give
// readable errors before the constraints would fire.

type Tx = DbTransaction;

const nowIso = () => new Date().toISOString();
const todayUtc = () => nowIso().slice(0, 10);

const DEFAULT_ROLE: MembershipRole = 'data';

function loadDrive(tx: Tx, id: string): Drive {
  const row = tx.select().from(drives).where(eq(drives.id, id)).get();
  if (!row) throw notFound(`Drive ${id} not found`);
  return row;
}

interface SlotInfo {
  slotId: string;
  slotLabel: string;
  gridId: string;
  gridName: string;
}

/** Labels as they are now; events copy them so history stays readable after renames (R39). */
function slotInfo(tx: Tx, slotId: string): SlotInfo {
  const slot = getSlot(tx, slotId);
  if (!slot) throw notFound(`Slot ${slotId} not found`);
  const grid = getGrid(tx, slot.gridId);
  return {
    slotId,
    slotLabel: slot.label ?? `Slot ${slot.position + 1}`,
    gridId: slot.gridId,
    gridName: grid?.name ?? '',
  };
}

function openMembership(tx: Tx, driveId: string) {
  return tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.driveId, driveId), isNull(memberships.endedAt)))
    .get();
}

/** Ends the drive's open membership (history kept) and logs pool-left. Returns what it ended. */
function endOpenMembership(
  tx: Tx,
  driveId: string,
  at: string,
): { poolId: string; role: MembershipRole } | null {
  const open = openMembership(tx, driveId);
  if (!open) return null;
  tx.update(memberships)
    .set({ endedAt: at < open.startedAt ? open.startedAt : at })
    .where(eq(memberships.id, open.id))
    .run();
  recordEvent(tx, {
    driveId,
    type: 'pool-left',
    at,
    payload: { poolId: open.poolId, role: open.role, membershipId: open.id },
  });
  return { poolId: open.poolId, role: open.role };
}

/** installed -> spare. Ends the membership, clears the slot, logs drive-removed. */
function freeSlot(tx: Tx, drive: Drive, note: string | null): Drive {
  if (drive.status !== 'installed' || drive.slotId === null) {
    throw conflict(`Drive ${drive.id} is not installed (${drive.status})`);
  }
  const at = nowIso();
  const info = slotInfo(tx, drive.slotId);
  const pool = endOpenMembership(tx, drive.id, at);
  const updated = tx
    .update(drives)
    .set({ status: 'spare', slotId: null, updatedAt: at })
    .where(eq(drives.id, drive.id))
    .returning()
    .get();
  recordEvent(tx, {
    driveId: drive.id,
    type: 'drive-removed',
    at,
    payload: {
      slotId: info.slotId,
      slotLabel: info.slotLabel,
      gridName: info.gridName,
      poolId: pool?.poolId ?? null,
      role: pool?.role ?? null,
      note,
    },
  });
  return updated;
}

interface RetireOptions {
  reason: RetirementReason;
  date: string;
  replacedByDriveId: string | null;
  note: string | null;
}

/** spare|installed -> retired (R60). Frees the slot first when installed. */
function retireInternal(tx: Tx, driveId: string, opts: RetireOptions): Drive {
  let drive = loadDrive(tx, driveId);
  if (drive.status === 'retired') throw conflict(`Drive ${drive.id} is already retired`);
  if (opts.replacedByDriveId !== null) {
    if (opts.replacedByDriveId === drive.id) {
      throw invalid('A drive cannot be replaced by itself');
    }
    if (!tx.select().from(drives).where(eq(drives.id, opts.replacedByDriveId)).get()) {
      throw notFound(`Replacement drive ${opts.replacedByDriveId} not found`);
    }
  }
  const slotId = drive.slotId;
  if (drive.status === 'installed') drive = freeSlot(tx, drive, null);
  const at = nowIso();
  const updated = tx
    .update(drives)
    .set({
      status: 'retired',
      slotId: null,
      retirementReason: opts.reason,
      retirementDate: opts.date,
      replacedByDriveId: opts.replacedByDriveId,
      retirementNote: opts.note,
      updatedAt: at,
    })
    .where(eq(drives.id, drive.id))
    .returning()
    .get();
  recordEvent(tx, {
    driveId: drive.id,
    type: 'drive-retired',
    at,
    payload: {
      reason: opts.reason,
      date: opts.date,
      replacedByDriveId: opts.replacedByDriveId,
      note: opts.note,
      slotId,
    },
  });
  return updated;
}

function rmaInternal(tx: Tx, driveId: string, date: string, note: string | null): Drive {
  const slotId = loadDrive(tx, driveId).slotId;
  const updated = retireInternal(tx, driveId, {
    reason: 'failed',
    date,
    replacedByDriveId: null,
    note,
  });
  recordEvent(tx, {
    driveId,
    type: 'drive-sent-for-rma',
    payload: { date, note, slotId },
  });
  return updated;
}

/** Pool and role a slot's most recent occupant had, from the events (R35). */
function previousOccupantOf(
  tx: Tx,
  slotId: string,
): { driveId: string; poolId: string | null; role: MembershipRole | null } | null {
  const rows = tx
    .select()
    .from(events)
    .where(inArray(events.type, ['drive-installed', 'drive-removed']))
    .orderBy(desc(events.at), desc(sql`rowid`))
    .all();
  const hit = rows.find((e) => e.payload.slotId === slotId && e.driveId !== null);
  if (!hit || hit.driveId === null) return null;
  const poolId = typeof hit.payload.poolId === 'string' ? hit.payload.poolId : null;
  const role =
    hit.payload.role === 'data' || hit.payload.role === 'hot-spare' ? hit.payload.role : null;
  return { driveId: hit.driveId, poolId, role };
}

function defaultsFor(tx: Tx, slotId: string): AssignmentDefaults {
  if (!getSlot(tx, slotId)) throw notFound(`Slot ${slotId} not found`);
  const current = tx.select().from(drives).where(eq(drives.slotId, slotId)).get();
  if (current) {
    // The occupant's live membership is the truest answer; it may have been edited since install.
    const open = openMembership(tx, current.id);
    return {
      poolId: open?.poolId ?? null,
      role: open?.role ?? null,
      previousDriveId: current.id,
    };
  }
  const prev = previousOccupantOf(tx, slotId);
  if (!prev) return { poolId: null, role: null, previousDriveId: null };
  const poolExists =
    prev.poolId !== null && tx.select().from(pools).where(eq(pools.id, prev.poolId)).get();
  return poolExists
    ? { poolId: prev.poolId, role: prev.role, previousDriveId: prev.driveId }
    : { poolId: null, role: null, previousDriveId: prev.driveId };
}

/** Defaults for the assign form (R35): the pool and role of the slot's current or last occupant. */
export function getAssignmentDefaults(db: AppDb, slotId: string): AssignmentDefaults {
  return db.transaction((tx) => defaultsFor(tx, slotId));
}

export interface AssignDriveInput {
  driveId: string;
  slotId: string;
  /** undefined = default from the previous occupant; null = no pool (R35). */
  poolId?: string | null | undefined;
  role?: MembershipRole | null | undefined;
  occupant?: OccupantResolution | undefined;
}

export interface AssignDriveResult {
  drive: Drive;
  /** The former occupant after it was resolved, when there was one. */
  occupant?: Drive;
}

/** spare -> installed (R8, R35, R37). An occupied slot is never silently replaced. */
export function assignDrive(db: AppDb, input: AssignDriveInput): AssignDriveResult {
  return db.transaction((tx) => {
    const drive = loadDrive(tx, input.driveId);
    if (drive.status === 'retired') throw invalid('Retired drives cannot be assigned');
    if (drive.status === 'installed') {
      throw conflict(`Drive ${drive.id} is installed; remove it from its current slot first`);
    }
    const info = slotInfo(tx, input.slotId);
    const defaults = defaultsFor(tx, input.slotId);
    const occupant = tx.select().from(drives).where(eq(drives.slotId, input.slotId)).get();

    let resolved: Drive | undefined;
    if (occupant) {
      const action = input.occupant;
      if (!action) {
        throw conflict(`Slot ${info.slotLabel} is occupied by ${occupant.serial}`, {
          occupant: { driveId: occupant.id, serial: occupant.serial },
        });
      }
      if (action.action === 'spare') {
        resolved = freeSlot(tx, occupant, null);
      } else if (action.action === 'retire') {
        const replacedBy =
          action.replacedByDriveId ?? (action.reason === 'replaced' ? drive.id : null);
        resolved = retireInternal(tx, occupant.id, {
          reason: action.reason,
          date: action.date,
          replacedByDriveId: replacedBy,
          note: action.note ?? null,
        });
      } else {
        resolved = rmaInternal(tx, occupant.id, action.date ?? todayUtc(), action.note ?? null);
      }
    }

    const poolId = input.poolId === undefined ? defaults.poolId : input.poolId;
    let role: MembershipRole | null = null;
    if (poolId !== null) {
      if (!tx.select().from(pools).where(eq(pools.id, poolId)).get()) {
        throw notFound(`Pool ${poolId} not found`);
      }
      role = input.role ?? defaults.role ?? DEFAULT_ROLE;
    }

    const at = nowIso();
    const updated = tx
      .update(drives)
      .set({ status: 'installed', slotId: input.slotId, updatedAt: at })
      .where(eq(drives.id, drive.id))
      .returning()
      .get();
    if (poolId !== null && role !== null) {
      tx.insert(memberships)
        .values({
          id: randomUUID(),
          driveId: drive.id,
          poolId,
          role,
          source: 'manual',
          startedAt: at,
          endedAt: null,
          createdAt: at,
        })
        .run();
      recordEvent(tx, {
        driveId: drive.id,
        type: 'pool-joined',
        at,
        payload: { poolId, role, slotId: input.slotId },
      });
    }
    recordEvent(tx, {
      driveId: drive.id,
      type: 'drive-installed',
      at,
      payload: { ...info, poolId, role },
    });
    return resolved ? { drive: updated, occupant: resolved } : { drive: updated };
  });
}

/** installed -> spare (back to the shelf). */
export function removeToSpares(
  db: AppDb,
  driveId: string,
  opts: { note?: string | null | undefined } = {},
): Drive {
  return db.transaction((tx) => freeSlot(tx, loadDrive(tx, driveId), opts.note ?? null));
}

export interface RetireDriveOptions {
  reason: RetirementReason;
  /** YYYY-MM-DD; defaults to today (UTC). */
  date?: string | undefined;
  replacedByDriveId?: string | null | undefined;
  note?: string | null | undefined;
}

/** spare|installed -> retired (R60). */
export function retireDrive(db: AppDb, driveId: string, opts: RetireDriveOptions): Drive {
  return db.transaction((tx) =>
    retireInternal(tx, driveId, {
      reason: opts.reason,
      date: opts.date ?? todayUtc(),
      replacedByDriveId: opts.replacedByDriveId ?? null,
      note: opts.note ?? null,
    }),
  );
}

/** Retire as failed plus a drive-sent-for-rma event (R27). */
export function sendForRma(
  db: AppDb,
  driveId: string,
  opts: { date?: string | undefined; note?: string | null | undefined } = {},
): Drive {
  return db.transaction((tx) =>
    rmaInternal(tx, driveId, opts.date ?? todayUtc(), opts.note ?? null),
  );
}

/** retired -> spare (R61). The earlier retirement stays in the history through the event payload. */
export function reinstateDrive(
  db: AppDb,
  driveId: string,
  opts: { note?: string | null | undefined } = {},
): Drive {
  return db.transaction((tx) => {
    const drive = loadDrive(tx, driveId);
    if (drive.status !== 'retired') {
      throw conflict(`Drive ${drive.id} is not retired (${drive.status})`);
    }
    const at = nowIso();
    const updated = tx
      .update(drives)
      .set({
        status: 'spare',
        retirementReason: null,
        retirementDate: null,
        replacedByDriveId: null,
        retirementNote: null,
        updatedAt: at,
      })
      .where(eq(drives.id, drive.id))
      .returning()
      .get();
    recordEvent(tx, {
      driveId: drive.id,
      type: 'drive-reinstated',
      at,
      payload: {
        previousReason: drive.retirementReason,
        previousDate: drive.retirementDate,
        previousReplacedByDriveId: drive.replacedByDriveId,
        previousNote: drive.retirementNote,
        note: opts.note ?? null,
      },
    });
    return updated;
  });
}
