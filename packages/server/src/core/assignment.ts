import { and, desc, eq, inArray, isNotNull, sql } from 'drizzle-orm';
import type {
  AssignmentDefaults,
  Drive,
  MembershipRole,
  OccupantResolution,
  RetirementReason,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { getGrid, getSlot } from '../db/layout-repo.js';
import { drives, events, pools } from '../db/schema.js';
import { conflict, invalid, notFound } from './errors.js';
import { recordEvent, type DbTransaction } from './events.js';
import {
  parseInstalledOn,
  parseNotFutureDate,
  startOfInstalledOn,
  todayUtc,
} from './installed-on.js';
import { endOpenMembership, openMembership, startMembership } from './memberships.js';

// Slot assignment and retirement (R8, R35, R37, R60, R61, R62, D7). Every public function runs in
// ONE transaction and writes its events through recordEvent in that same transaction (R14), so a
// failure at any point leaves no partial state. D7 (one drive per slot, one slot per drive) is
// enforced by the unique index on drives.slot_id plus the status/slot CHECKs; the checks here give
// readable errors before the constraints would fire.

type Tx = DbTransaction;

const nowIso = () => new Date().toISOString();

const DEFAULT_ROLE: MembershipRole = 'data';

export function loadDrive(tx: Tx, id: string): Drive {
  const row = tx.select().from(drives).where(eq(drives.id, id)).get();
  if (!row) throw notFound(`Drive ${id} not found`);
  return row;
}

export interface SlotInfo {
  slotId: string;
  slotLabel: string;
  gridId: string;
  gridName: string;
}

/** Labels as they are now; events copy them so history stays readable after renames (R39). */
export function slotInfo(tx: Tx, slotId: string): SlotInfo {
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

/** R69: the day the drive left its slot, as the slot-freeing step records it. */
export interface Removal {
  /** YYYY-MM-DD, or null when not recorded. */
  removedOn: string | null;
  /**
   * True only for removing to the spares (R69). A past date then backdates the membership end and is
   * checked against the installation date and the pool start. Retire and RMA only record the date in
   * the event payload and end the membership at the time of recording.
   */
  backdate: boolean;
}

/** R69: the removal date for a request. Omitted = today (UTC); null = not recorded; otherwise validated. */
export function removalDateOf(value: string | null | undefined, clock: Date): string | null {
  if (value === undefined) return todayUtc(clock);
  return value === null ? null : parseNotFutureDate('removedOn', value, clock);
}

/**
 * R60: the retirement date for a request. Omitted = today (UTC); null = not recorded (never guessed);
 * otherwise a calendar date that is not in the future. There is deliberately no check against the
 * installation date (parking lot).
 */
export function retirementDateOf(value: string | null | undefined, clock: Date): string | null {
  if (value === undefined) return todayUtc(clock);
  return value === null ? null : parseNotFutureDate('date', value, clock);
}

/** R69: a removal date may not precede the installation date or the start of the pool membership. */
function assertRemovalAfterStart(
  drive: Drive,
  membershipStartedAt: string | null,
  removedOn: string,
): void {
  if (drive.installedOn !== null && removedOn < drive.installedOn) {
    throw invalid(
      `A drive can't be removed before it was installed (installed on ${drive.installedOn})`,
    );
  }
  if (
    membershipStartedAt !== null &&
    Date.parse(`${removedOn}T00:00:00.000Z`) < Date.parse(membershipStartedAt)
  ) {
    throw invalid(
      `A drive can't be removed before it joined the pool (joined on ${membershipStartedAt.slice(0, 10)})`,
    );
  }
}

/** installed -> spare. Ends the membership, clears the slot, logs drive-removed (R14, R69). */
export function freeSlot(tx: Tx, drive: Drive, note: string | null, removal: Removal): Drive {
  if (drive.status !== 'installed' || drive.slotId === null) {
    throw conflict(`Drive ${drive.id} is not installed (${drive.status})`);
  }
  const at = nowIso();
  const info = slotInfo(tx, drive.slotId);
  // R69: a past removal date backdates the membership end; the event is still stamped at `at`.
  const backdated =
    removal.backdate && removal.removedOn !== null && removal.removedOn < todayUtc(new Date(at));
  if (removal.backdate && removal.removedOn !== null) {
    // Nothing is written before this check, so a rejected date leaves the drive and membership as they were.
    const open = backdated ? openMembership(tx, drive.id) : undefined;
    assertRemovalAfterStart(drive, open?.startedAt ?? null, removal.removedOn);
  }
  const endAt = backdated ? `${removal.removedOn}T00:00:00.000Z` : at;
  const pool = endOpenMembership(tx, drive.id, endAt, backdated);
  const updated = tx
    .update(drives)
    .set({ status: 'spare', slotId: null, installedOn: null, updatedAt: at })
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
      // R68: the history keeps the installation date, so time in the slot can be computed.
      installedOn: drive.installedOn,
      // R69: the day it physically left (null = not recorded). `at` above is when it was recorded.
      removedOn: removal.removedOn,
      note,
    },
  });
  return updated;
}

export interface RetireOptions {
  reason: RetirementReason;
  /** Already validated YYYY-MM-DD, or null = not recorded (R60). */
  date: string | null;
  replacedByDriveId: string | null;
  note: string | null;
}

/** spare|installed -> retired (R60). Frees the slot first when installed. */
export function retireInternal(tx: Tx, driveId: string, opts: RetireOptions): Drive {
  let drive = loadDrive(tx, driveId);
  if (drive.status === 'retired') throw conflict(`Drive ${drive.id} is already retired`);
  if (opts.replacedByDriveId !== null) {
    if (opts.replacedByDriveId === drive.id) {
      throw invalid('A drive cannot be replaced by itself');
    }
    if (!tx.select().from(drives).where(eq(drives.id, opts.replacedByDriveId)).get()) {
      throw notFound(`Replacement drive ${opts.replacedByDriveId} not found`);
    }
    // Walk the replacement chain: it must never lead back to the drive being retired.
    const seen = new Set<string>();
    for (
      let next: string | null = opts.replacedByDriveId;
      next !== null && !seen.has(next);
      next = tx.select().from(drives).where(eq(drives.id, next)).get()?.replacedByDriveId ?? null
    ) {
      if (next === drive.id) {
        throw invalid('Replacement chain would loop back to this drive');
      }
      seen.add(next);
    }
  }
  const slotId = drive.slotId;
  // R69: the retirement date is the day the drive left the slot.
  if (drive.status === 'installed') {
    drive = freeSlot(tx, drive, null, { removedOn: opts.date, backdate: false });
  }
  const at = nowIso();
  const updated = tx
    .update(drives)
    .set({
      status: 'retired',
      slotId: null,
      installedOn: null,
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

export function rmaInternal(
  tx: Tx,
  driveId: string,
  date: string | null,
  note: string | null,
  replacedByDriveId: string | null = null,
): Drive {
  const slotId = loadDrive(tx, driveId).slotId;
  const updated = retireInternal(tx, driveId, {
    reason: 'failed',
    date,
    replacedByDriveId,
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
  // Latest install or removal for this slot by insertion order (rowid), not by the `at` text.
  const hit = tx
    .select()
    .from(events)
    .where(
      and(
        inArray(events.type, ['drive-installed', 'drive-removed']),
        isNotNull(events.driveId),
        sql`json_extract(${events.payload}, '$.slotId') = ${slotId}`,
      ),
    )
    .orderBy(desc(sql`rowid`))
    .limit(1)
    .get();
  if (!hit || hit.driveId === null) return null;
  const poolId = typeof hit.payload.poolId === 'string' ? hit.payload.poolId : null;
  const role =
    hit.payload.role === 'data' || hit.payload.role === 'hot-spare' ? hit.payload.role : null;
  return { driveId: hit.driveId, poolId, role };
}

export function defaultsFor(tx: Tx, slotId: string): AssignmentDefaults {
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

/** R37: the 409 for an occupied slot, carrying the occupant so a client can ask what to do with it. */
export function occupiedError(info: SlotInfo, occupant: Drive) {
  return conflict(`Slot ${info.slotLabel} is occupied by ${occupant.serial}`, {
    occupant: { driveId: occupant.id, serial: occupant.serial },
  });
}

/**
 * R37, R62: resolve the drive in a slot before another one goes in. `incomingId` is the drive that
 * takes the slot (the default "replaced by" for reason 'replaced'). A date the action leaves out
 * (undefined) falls back to `defaultDate` when that is given (R73: the one move date), else today.
 */
export function resolveOccupant(
  tx: Tx,
  occupant: Drive,
  action: OccupantResolution,
  incomingId: string,
  clock: Date,
  defaultDate: string | null | undefined,
): Drive {
  if (action.action === 'spare') {
    return freeSlot(tx, occupant, null, {
      removedOn:
        action.removedOn === undefined && defaultDate !== undefined
          ? defaultDate
          : removalDateOf(action.removedOn, clock),
      backdate: true,
    });
  }
  const date = (value: string | null | undefined): string | null =>
    value === undefined && defaultDate !== undefined ? defaultDate : retirementDateOf(value, clock);
  if (action.action === 'retire') {
    // R62: undefined = prefill the incoming drive for 'replaced'; an explicit null = no replacement.
    const replacedBy =
      action.replacedByDriveId === undefined
        ? action.reason === 'replaced'
          ? incomingId
          : null
        : action.replacedByDriveId;
    return retireInternal(tx, occupant.id, {
      reason: action.reason,
      date: date(action.date),
      replacedByDriveId: replacedBy,
      note: action.note ?? null,
    });
  }
  return rmaInternal(tx, occupant.id, date(action.date), action.note ?? null);
}

/** R35: the pool and role a drive joins (undefined = default from the slot's previous occupant; null = no pool). */
export function resolvePoolRole(
  tx: Tx,
  poolIdInput: string | null | undefined,
  roleInput: MembershipRole | null | undefined,
  defaults: AssignmentDefaults,
): { poolId: string | null; role: MembershipRole | null } {
  const poolId = poolIdInput === undefined ? defaults.poolId : poolIdInput;
  if (poolId === null) return { poolId: null, role: null };
  if (!tx.select().from(pools).where(eq(pools.id, poolId)).get()) {
    throw notFound(`Pool ${poolId} not found`);
  }
  return { poolId, role: roleInput ?? defaults.role ?? DEFAULT_ROLE };
}

/** spare -> installed in an empty slot: opens the membership (R29) and logs drive-installed (R14). */
export function placeSpare(
  tx: Tx,
  drive: Drive,
  slotId: string,
  info: SlotInfo,
  o: {
    poolId: string | null;
    role: MembershipRole | null;
    installedOn: string | null;
    /** Extra drive-installed payload keys. */
    payload?: Record<string, unknown>;
  },
): Drive {
  const at = nowIso();
  const updated = tx
    .update(drives)
    .set({ status: 'installed', slotId, installedOn: o.installedOn, updatedAt: at })
    .where(eq(drives.id, drive.id))
    .returning()
    .get();
  if (o.poolId !== null && o.role !== null) {
    // R29/R68: the membership starts when the drive went in; the events stay stamped "now".
    // An unrecorded installation date starts it at the recording time.
    const start =
      o.installedOn === null
        ? { startedAt: at, userSupplied: false }
        : startOfInstalledOn(o.installedOn, new Date(at));
    startMembership(tx, {
      driveId: drive.id,
      poolId: o.poolId,
      role: o.role,
      startedAt: start.startedAt,
      slotId,
      userSupplied: start.userSupplied,
    });
  }
  // R14: `at` is when the change was recorded; the installation date travels in the payload.
  recordEvent(tx, {
    driveId: drive.id,
    type: 'drive-installed',
    at,
    payload: { ...info, poolId: o.poolId, role: o.role, installedOn: o.installedOn, ...o.payload },
  });
  return updated;
}

export interface AssignDriveInput {
  driveId: string;
  slotId: string;
  /** undefined = default from the previous occupant; null = no pool (R35). */
  poolId?: string | null | undefined;
  role?: MembershipRole | null | undefined;
  occupant?: OccupantResolution | undefined;
  /**
   * R68: YYYY-MM-DD the drive actually went in, never in the future. undefined = today (UTC);
   * null = "installation date not recorded" (an unknown date is stored as such, never guessed).
   */
  installedOn?: string | null | undefined;
}

export interface AssignDriveResult {
  drive: Drive;
  /** The former occupant after it was resolved, when there was one. */
  occupant?: Drive;
}

/** spare -> installed (R8, R35, R37). An occupied slot is never silently replaced. */
export function assignDrive(db: AppDb, input: AssignDriveInput): AssignDriveResult {
  const clock = new Date();
  const installedOn =
    input.installedOn === undefined
      ? todayUtc(clock)
      : input.installedOn === null
        ? null
        : parseInstalledOn(input.installedOn, clock);
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
      if (!input.occupant) throw occupiedError(info, occupant);
      resolved = resolveOccupant(tx, occupant, input.occupant, drive.id, clock, undefined);
    }

    const { poolId, role } = resolvePoolRole(tx, input.poolId, input.role, defaults);
    const updated = placeSpare(tx, drive, input.slotId, info, { poolId, role, installedOn });
    return resolved ? { drive: updated, occupant: resolved } : { drive: updated };
  });
}

export interface RemoveToSparesOptions {
  note?: string | null | undefined;
  /** R69: YYYY-MM-DD the drive physically left. Omitted = today (UTC); null = not recorded. */
  removedOn?: string | null | undefined;
}

/** installed -> spare (back to the shelf). R69: records when it was physically removed. */
export function removeToSpares(
  db: AppDb,
  driveId: string,
  opts: RemoveToSparesOptions = {},
): Drive {
  const removedOn = removalDateOf(opts.removedOn, new Date());
  return db.transaction((tx) =>
    freeSlot(tx, loadDrive(tx, driveId), opts.note ?? null, { removedOn, backdate: true }),
  );
}

export interface RetireDriveOptions {
  reason: RetirementReason;
  /** R60: YYYY-MM-DD, never in the future. Omitted = today (UTC); null = not recorded. */
  date?: string | null | undefined;
  replacedByDriveId?: string | null | undefined;
  note?: string | null | undefined;
}

/** spare|installed -> retired (R60). */
export function retireDrive(db: AppDb, driveId: string, opts: RetireDriveOptions): Drive {
  const date = retirementDateOf(opts.date, new Date());
  return db.transaction((tx) =>
    retireInternal(tx, driveId, {
      reason: opts.reason,
      date,
      replacedByDriveId: opts.replacedByDriveId ?? null,
      note: opts.note ?? null,
    }),
  );
}

/** Retire as failed plus a drive-sent-for-rma event (R27). */
export function sendForRma(
  db: AppDb,
  driveId: string,
  opts: { date?: string | null | undefined; note?: string | null | undefined } = {},
): Drive {
  const date = retirementDateOf(opts.date, new Date());
  return db.transaction((tx) => rmaInternal(tx, driveId, date, opts.note ?? null));
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
