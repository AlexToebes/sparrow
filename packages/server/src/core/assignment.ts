import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import type {
  AssignmentDefaults,
  Drive,
  MembershipRole,
  OccupantResolution,
  RetirementReason,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { getGrid, getSlot } from '../db/layout-repo.js';
import { eventSlots, events, drives, pools } from '../db/schema.js';
import { conflict, invalid, notFound } from './errors.js';
import { loadLinks, recordEvent, type DbTransaction } from './events.js';
import {
  parseInstalledOn,
  parseNotFutureDate,
  startOfInstalledOn,
  todayUtc,
} from './installed-on.js';
import { endOpenMembership, openMembership, startMembership } from './memberships.js';

// Slot assignment and retirement (R8, R35, R37, R60, R61, R62, D7). Every public function runs in
// ONE transaction and writes its events through recordEvent in that same transaction (R14), so a
// failure at any point leaves no partial state. One real action is ONE event with links to every
// drive and slot it involves: a drive arriving in an occupied bay is a single drive-replaced event
// (outgoing + incoming drive, the bay as slot `at`), never a removal plus an installation. D7 (one drive per slot, one slot per drive) is
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

/** The pool and role a drive held when it left its bay; copied into events so R35 can default from them. */
export interface PoolRef {
  poolId: string | null;
  role: MembershipRole | null;
}

/** DB part of installed -> spare: ends the membership (pool-left), clears the slot. Writes no drive event. */
function leaveSlot(
  tx: Tx,
  drive: Drive,
  removal: Removal,
): { drive: Drive; pool: PoolRef; slotId: string } {
  if (drive.status !== 'installed' || drive.slotId === null) {
    throw conflict(`Drive ${drive.id} is not installed (${drive.status})`);
  }
  const at = nowIso();
  const slotId = drive.slotId;
  // R69: a past removal date backdates the membership end; the event is still stamped at `at`.
  const backdated =
    removal.backdate && removal.removedOn !== null && removal.removedOn < todayUtc(new Date(at));
  if (removal.backdate && removal.removedOn !== null) {
    // Nothing is written before this check, so a rejected date leaves the drive and membership as they were.
    const open = backdated ? openMembership(tx, drive.id) : undefined;
    assertRemovalAfterStart(drive, open?.startedAt ?? null, removal.removedOn);
  }
  const endAt = backdated ? `${removal.removedOn}T00:00:00.000Z` : at;
  const ended = endOpenMembership(tx, drive.id, endAt, backdated);
  const updated = tx
    .update(drives)
    .set({ status: 'spare', slotId: null, installedOn: null, updatedAt: at })
    .where(eq(drives.id, drive.id))
    .returning()
    .get();
  return {
    drive: updated,
    pool: { poolId: ended?.poolId ?? null, role: ended?.role ?? null },
    slotId,
  };
}

/** installed -> spare. Ends the membership, clears the slot, logs drive-removed (R14, R69). */
export function freeSlot(tx: Tx, drive: Drive, note: string | null, removal: Removal): Drive {
  const left = leaveSlot(tx, drive, removal);
  recordEvent(tx, {
    type: 'drive-removed',
    drives: [{ id: drive.id }],
    slots: [{ id: left.slotId, role: 'from' }],
    payload: {
      ...left.pool,
      // R68: the history keeps the installation date, so time in the slot can be computed.
      installedOn: drive.installedOn,
      // R69: the day it physically left (null = not recorded). The event's `at` is when it was recorded.
      removedOn: removal.removedOn,
      note,
    },
  });
  return left.drive;
}

export interface RetireOptions {
  reason: RetirementReason;
  /** Already validated YYYY-MM-DD, or null = not recorded (R60). */
  date: string | null;
  note: string | null;
}

/** DB part of spare|installed -> retired (R60). Frees the slot first when installed. Writes no drive event. */
function retireCore(
  tx: Tx,
  driveId: string,
  opts: RetireOptions,
): { drive: Drive; slotId: string | null; pool: PoolRef; installedOn: string | null } {
  let drive = loadDrive(tx, driveId);
  if (drive.status === 'retired') throw conflict(`Drive ${drive.id} is already retired`);
  const slotId = drive.slotId;
  const installedOn = drive.installedOn;
  let pool: PoolRef = { poolId: null, role: null };
  // R69: the retirement date is the day the drive left the slot.
  if (drive.status === 'installed') {
    const left = leaveSlot(tx, drive, { removedOn: opts.date, backdate: false });
    drive = left.drive;
    pool = left.pool;
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
      retirementNote: opts.note,
      updatedAt: at,
    })
    .where(eq(drives.id, drive.id))
    .returning()
    .get();
  return { drive: updated, slotId, pool, installedOn };
}

/** spare|installed -> retired (R60): ONE drive-retired event, linked to the bay it left when installed. */
export function retireInternal(tx: Tx, driveId: string, opts: RetireOptions): Drive {
  const r = retireCore(tx, driveId, opts);
  recordEvent(tx, {
    type: 'drive-retired',
    drives: [{ id: driveId }],
    slots: r.slotId === null ? [] : [{ id: r.slotId, role: 'from' }],
    payload: {
      reason: opts.reason,
      date: opts.date,
      note: opts.note,
      ...r.pool,
      installedOn: r.installedOn,
    },
  });
  return r.drive;
}

/** Retire as failed (R27): ONE drive-sent-for-rma event, which implies the retirement. */
export function rmaInternal(
  tx: Tx,
  driveId: string,
  date: string | null,
  note: string | null,
): Drive {
  const r = retireCore(tx, driveId, { reason: 'failed', date, note });
  recordEvent(tx, {
    type: 'drive-sent-for-rma',
    drives: [{ id: driveId }],
    slots: r.slotId === null ? [] : [{ id: r.slotId, role: 'from' }],
    payload: { date, note, ...r.pool, installedOn: r.installedOn },
  });
  return r.drive;
}

/** What became of the drive a replacement displaced; the drive-replaced event carries it (R74). */
export interface Outgoing {
  /** The displaced drive after the change. */
  drive: Drive;
  outcome: 'spares' | 'retired' | 'rma' | 'moved';
  /** removedOn (spares), the retirement date (retired / rma) or the move date (moved); null = not recorded. */
  date: string | null;
  reason?: RetirementReason;
  note?: string | null;
  /** Where it went, when the outcome is `moved`. */
  toSlotId?: string;
  pool: PoolRef;
  /** R68: when it had gone in, before this change. */
  installedOn: string | null;
}

/** The `outgoing` object of a drive-replaced payload. */
export const outgoingPayload = (o: Outgoing): Record<string, unknown> => ({
  outcome: o.outcome,
  date: o.date,
  ...(o.reason === undefined ? {} : { reason: o.reason }),
  ...(o.note === undefined ? {} : { note: o.note }),
  ...(o.toSlotId === undefined ? {} : { toSlotId: o.toSlotId }),
  ...o.pool,
  installedOn: o.installedOn,
});

/** Event types that put a drive into a bay or take one out, i.e. the ones that change who sits there. */
const OCCUPANCY_TYPES = [
  'drive-installed',
  'drive-removed',
  'drive-retired',
  'drive-sent-for-rma',
  'drive-moved',
  'drives-swapped',
  'drive-replaced',
] as const;

const asRole = (v: unknown): MembershipRole | null =>
  v === 'data' || v === 'hot-spare' ? v : null;
const asPoolId = (v: unknown): string | null => (typeof v === 'string' ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * The drive that most recently sat in, or left, a bay, with the pool and role it had there (R35).
 * Read from the events linked to the slot, newest first by insertion order (rowid), not by the `at` text.
 */
function previousOccupantOf(
  tx: Tx,
  slotId: string,
): { driveId: string; poolId: string | null; role: MembershipRole | null } | null {
  const hit = tx
    .select({
      id: events.id,
      type: events.type,
      payload: events.payload,
      slotRole: eventSlots.role,
    })
    .from(eventSlots)
    .innerJoin(events, eq(events.id, eventSlots.eventId))
    .where(and(eq(eventSlots.slotId, slotId), inArray(events.type, [...OCCUPANCY_TYPES])))
    .orderBy(desc(sql`"events".rowid`))
    .limit(1)
    .get();
  if (!hit) return null;
  const links = loadLinks(tx, [hit.id]).get(hit.id)!;
  const p = hit.payload;
  const driveWith = (role: 'subject' | 'outgoing' | 'incoming') =>
    links.drives.find((d) => d.role === role)?.driveId;

  if (hit.type === 'drive-replaced') {
    const outgoing = isRecord(p.outgoing) ? p.outgoing : {};
    // `at` is the bay itself (the incoming drive sits there now); `to` is where the outgoing one went.
    if (hit.slotRole === 'to') {
      const id = driveWith('outgoing');
      return id
        ? { driveId: id, poolId: asPoolId(outgoing.poolId), role: asRole(outgoing.role) }
        : null;
    }
    const id = driveWith('incoming');
    return id ? { driveId: id, poolId: asPoolId(p.poolId), role: asRole(p.role) } : null;
  }
  if (hit.type === 'drives-swapped') {
    const moves = Array.isArray(p.moves) ? p.moves.filter(isRecord) : [];
    const arrived = moves.find((m) => m.toSlotId === slotId);
    return arrived && typeof arrived.driveId === 'string'
      ? { driveId: arrived.driveId, poolId: asPoolId(arrived.poolId), role: asRole(arrived.role) }
      : null;
  }
  const id = driveWith('subject');
  return id ? { driveId: id, poolId: asPoolId(p.poolId), role: asRole(p.role) } : null;
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
 * R37, R62: resolve the drive in a slot before another one goes in. A date the action leaves out
 * (undefined) falls back to `defaultDate` when that is given (R73: the one move date), else today.
 * It changes the drive but writes no event: the caller records the single drive-replaced event for
 * the whole replacement from the returned description.
 */
export function resolveOccupant(
  tx: Tx,
  occupant: Drive,
  action: OccupantResolution,
  clock: Date,
  defaultDate: string | null | undefined,
): Outgoing {
  const installedOn = occupant.installedOn;
  if (action.action === 'spare') {
    const removedOn =
      action.removedOn === undefined && defaultDate !== undefined
        ? defaultDate
        : removalDateOf(action.removedOn, clock);
    const left = leaveSlot(tx, occupant, { removedOn, backdate: true });
    return {
      drive: left.drive,
      outcome: 'spares',
      date: removedOn,
      note: null,
      pool: left.pool,
      installedOn,
    };
  }
  const date = (value: string | null | undefined): string | null =>
    value === undefined && defaultDate !== undefined ? defaultDate : retirementDateOf(value, clock);
  if (action.action === 'retire') {
    const opts = { reason: action.reason, date: date(action.date), note: action.note ?? null };
    const r = retireCore(tx, occupant.id, opts);
    return {
      drive: r.drive,
      outcome: 'retired',
      date: opts.date,
      reason: opts.reason,
      note: opts.note,
      pool: r.pool,
      installedOn,
    };
  }
  const opts = { reason: 'failed' as const, date: date(action.date), note: action.note ?? null };
  const r = retireCore(tx, occupant.id, opts);
  return {
    drive: r.drive,
    outcome: 'rma',
    date: opts.date,
    note: opts.note,
    pool: r.pool,
    installedOn,
  };
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

/**
 * spare -> installed in a slot: opens the membership (R29) and logs ONE event (R14). Into an empty
 * slot that is drive-installed; into an occupied one (`replaced` describes the displaced drive,
 * already resolved) it is drive-replaced, linking both drives and the bay.
 */
export function placeSpare(
  tx: Tx,
  drive: Drive,
  slotId: string,
  o: {
    poolId: string | null;
    role: MembershipRole | null;
    installedOn: string | null;
    replaced?: Outgoing | undefined;
    /** Extra slot links on a drive-replaced event, e.g. the bay a mover came from or the outgoing drive went to. */
    extraSlots?: { id: string; role: 'from' | 'to' }[];
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
      userSupplied: start.userSupplied,
    });
  }
  // R14: `at` is when the change was recorded; the installation date travels in the payload.
  const pool = { poolId: o.poolId, role: o.role };
  if (o.replaced) {
    recordEvent(tx, {
      type: 'drive-replaced',
      at,
      drives: [
        { id: o.replaced.drive.id, role: 'outgoing' },
        { id: drive.id, role: 'incoming' },
      ],
      slots: [{ id: slotId, role: 'at' }, ...(o.extraSlots ?? [])],
      payload: { installedOn: o.installedOn, ...pool, outgoing: outgoingPayload(o.replaced) },
    });
  } else {
    recordEvent(tx, {
      type: 'drive-installed',
      at,
      drives: [{ id: drive.id }],
      slots: [{ id: slotId, role: 'to' }],
      payload: { installedOn: o.installedOn, ...pool },
    });
  }
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

    let replaced: Outgoing | undefined;
    if (occupant) {
      if (!input.occupant) throw occupiedError(info, occupant);
      replaced = resolveOccupant(tx, occupant, input.occupant, clock, undefined);
    }

    const { poolId, role } = resolvePoolRole(tx, input.poolId, input.role, defaults);
    const updated = placeSpare(tx, drive, input.slotId, { poolId, role, installedOn, replaced });
    return replaced ? { drive: updated, occupant: replaced.drive } : { drive: updated };
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
  note?: string | null | undefined;
}

/** spare|installed -> retired (R60). */
export function retireDrive(db: AppDb, driveId: string, opts: RetireDriveOptions): Drive {
  const date = retirementDateOf(opts.date, new Date());
  return db.transaction((tx) =>
    retireInternal(tx, driveId, {
      reason: opts.reason,
      date,
      note: opts.note ?? null,
    }),
  );
}

/** Retire as failed with a single drive-sent-for-rma event (R27). */
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
        retirementNote: null,
        updatedAt: at,
      })
      .where(eq(drives.id, drive.id))
      .returning()
      .get();
    recordEvent(tx, {
      type: 'drive-reinstated',
      at,
      drives: [{ id: drive.id }],
      payload: {
        previousReason: drive.retirementReason,
        previousDate: drive.retirementDate,
        previousNote: drive.retirementNote,
        note: opts.note ?? null,
      },
    });
    return updated;
  });
}
