import { and, desc, eq } from 'drizzle-orm';
import type {
  AssignmentDefaults,
  Drive,
  MembershipRole,
  OccupantResolution,
  RetirementReason,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { getGrid, getSlot } from '../db/layout-repo.js';
import { activities, drives, events, pools } from '../db/schema.js';
import {
  recordActivity,
  slotDisplayLabel,
  type DbTransaction,
  type EventInput,
} from './activities.js';
import { driveInSlot, getDrive } from './drives.js';
import { conflict, invalid, notFound } from './errors.js';
import {
  installationInSlot,
  installationOfDrive,
  installDrive,
  uninstallDrive,
  type PoolRef,
} from './installations.js';
import { parseInstalledOn, parseNotFutureDate, todayUtc } from './installed-on.js';

// Slot assignment and retirement (R8, R35, R37, R60, R61, R62, D7). Every public function runs in
// ONE transaction and records ONE activity in that same transaction (R14), so a failure at any point
// leaves no partial state. The helpers here change the tables and append event descriptors to the
// caller's list; only the top-level action records the activity. D7 (one drive per bay, one bay per
// drive) is enforced by the unique indexes on installations; the checks here give readable errors
// before the constraints would fire.

type Tx = DbTransaction;

const nowIso = () => new Date().toISOString();

const DEFAULT_ROLE: MembershipRole = 'data';

/** Loads a drive with its computed status and installation fields, or 404. */
export const loadDrive = (tx: Tx, id: string): Drive => getDrive(tx, id);

export interface SlotInfo {
  slotId: string;
  slotLabel: string;
  gridId: string;
  gridName: string;
}

/** Labels as they are now; used in messages. */
export function slotInfo(tx: Tx, slotId: string): SlotInfo {
  const slot = getSlot(tx, slotId);
  if (!slot) throw notFound(`Slot ${slotId} not found`);
  const grid = getGrid(tx, slot.gridId);
  return {
    slotId,
    slotLabel: slotDisplayLabel(slot),
    gridId: slot.gridId,
    gridName: grid?.name ?? '',
  };
}

/** R69: the day the drive left its slot, as the slot-freeing step records it. */
export interface Removal {
  /** YYYY-MM-DD, or null when not recorded. */
  removedOn: string | null;
  /**
   * True only for removing to the spares (R69): the date is then checked against the installation
   * date. Retire and RMA record their own date (R60) without that check.
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

/** R68: the installation date for an assignment. Omitted = today (UTC); null = not recorded. */
export function installedOnOf(value: string | null | undefined, clock: Date): string | null {
  return value === undefined
    ? todayUtc(clock)
    : value === null
      ? null
      : parseInstalledOn(value, clock);
}

/**
 * installed -> out of its bay: deletes the installation and appends drive-uninstalled (R14, R69). A
 * removal date may not precede the installation date. Returns the pool and role the drive left with.
 */
function leaveSlot(tx: Tx, drive: Drive, removal: Removal, evs: EventInput[]): PoolRef {
  const installation = installationOfDrive(tx, drive.id);
  if (!installation) throw conflict(`Drive ${drive.id} is not installed (${drive.status})`);
  if (
    removal.backdate &&
    removal.removedOn !== null &&
    installation.installedOn !== null &&
    removal.removedOn < installation.installedOn
  ) {
    throw invalid(
      `A drive can't be removed before it was installed (installed on ${installation.installedOn})`,
    );
  }
  uninstallDrive(tx, installation, evs);
  return { poolId: installation.poolId, role: installation.poolRole };
}

/** installed -> spare (back to the shelf): one drive-uninstalled event (R14, R69). */
export function freeSlot(tx: Tx, drive: Drive, removal: Removal, evs: EventInput[]): PoolRef {
  return leaveSlot(tx, drive, removal, evs);
}

export interface RetireOptions {
  reason: RetirementReason;
  /** Already validated YYYY-MM-DD, or null = not recorded (R60). */
  date: string | null;
  note: string | null;
}

/**
 * spare|installed -> retired (R60), or sent for RMA (R27: retired as failed, one drive-sent-for-rma
 * event that implies the retirement). An installed drive is uninstalled first; the retirement date is
 * the day it left the bay (R69). `opts.date` is the day the calling activity records as its occurred-on:
 * the retirement fields are set from null, so the event holds the reason and note and the activity the date.
 */
export function retireInternal(
  tx: Tx,
  driveId: string,
  opts: RetireOptions,
  evs: EventInput[],
  rma = false,
): Drive {
  const drive = getDrive(tx, driveId);
  if (drive.status === 'retired') throw conflict(`Drive ${drive.id} is already retired`);
  if (drive.status === 'installed')
    leaveSlot(tx, drive, { removedOn: opts.date, backdate: false }, evs);
  tx.update(drives)
    .set({
      retirementReason: opts.reason,
      retirementDate: opts.date,
      retirementNote: opts.note,
      updatedAt: nowIso(),
    })
    .where(eq(drives.id, driveId))
    .run();
  evs.push(
    rma
      ? { type: 'drive-sent-for-rma', driveId, payload: { note: opts.note } }
      : { type: 'drive-retired', driveId, payload: { reason: opts.reason, note: opts.note } },
  );
  return getDrive(tx, driveId);
}

/** Retire as failed (R27): ONE drive-sent-for-rma event, which implies the retirement. */
export function rmaInternal(
  tx: Tx,
  driveId: string,
  date: string | null,
  note: string | null,
  evs: EventInput[],
): Drive {
  return retireInternal(tx, driveId, { reason: 'failed', date, note }, evs, true);
}

/**
 * R35: the drive that most recently left a bay, with the pool and role it had there. The log is the
 * source: the latest `drive-uninstalled` event of the slot (newest by activity seq, then order).
 */
function previousOccupantOf(
  tx: Tx,
  slotId: string,
): { driveId: string; poolId: string | null; role: MembershipRole | null } | null {
  const hit = tx
    .select({ driveId: events.driveId, poolId: events.poolId, payload: events.payload })
    .from(events)
    .innerJoin(activities, eq(activities.id, events.activityId))
    .where(and(eq(events.slotId, slotId), eq(events.type, 'drive-uninstalled')))
    .orderBy(desc(activities.seq), desc(events.ord))
    .limit(1)
    .get();
  if (!hit?.driveId) return null;
  const role = hit.payload.poolRole;
  return {
    driveId: hit.driveId,
    poolId: hit.poolId,
    role: role === 'data' || role === 'hot-spare' ? role : null,
  };
}

export function defaultsFor(tx: Tx, slotId: string): AssignmentDefaults {
  if (!getSlot(tx, slotId)) throw notFound(`Slot ${slotId} not found`);
  // The occupant's live installation is the truest answer; it may have been edited since it went in.
  const live = installationInSlot(tx, slotId);
  if (live) return { poolId: live.poolId, role: live.poolRole, previousDriveId: live.driveId };
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
 * R69, R73: a replacement is ONE physical act, so the drive in the bay leaves on the day the other one
 * goes in. A date the request gives for the occupant (removedOn, or the retirement date) must be that
 * same day; leaving it out means that day. A different day is a 400.
 */
function assertSameDay(
  field: 'removedOn' | 'date',
  given: string | null | undefined,
  day: string | null,
): void {
  if (given !== undefined && given !== day) {
    throw invalid(
      `The occupant's ${field} must be the same day as the replacement (${day ?? 'not recorded'}): the drive in the bay leaves when the new one goes in`,
    );
  }
}

/**
 * R37, R62: resolve the drive in a slot before another one goes in. `date` is the day of the whole
 * action (the activity's occurred-on: the installation day, or the move date); the occupant's removal
 * or retirement happens that day (R69, R73). It appends the occupant's events (uninstalled, and
 * retired / sent-for-rma) and returns the drive as it is afterwards.
 */
export function resolveOccupant(
  tx: Tx,
  occupant: Drive,
  action: OccupantResolution,
  date: string | null,
  evs: EventInput[],
): Drive {
  if (action.action === 'spare') {
    assertSameDay('removedOn', action.removedOn, date);
    leaveSlot(tx, occupant, { removedOn: date, backdate: true }, evs);
    return getDrive(tx, occupant.id);
  }
  assertSameDay('date', action.date, date);
  if (action.action === 'retire') {
    return retireInternal(
      tx,
      occupant.id,
      { reason: action.reason, date, note: action.note ?? null },
      evs,
    );
  }
  return rmaInternal(tx, occupant.id, date, action.note ?? null, evs);
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

/** spare -> installed in a bay: the installation, with its pool and role (R29), and one drive-installed event. */
export function placeSpare(
  tx: Tx,
  drive: Drive,
  slotId: string,
  o: { poolId: string | null; role: MembershipRole | null; installedOn: string | null },
  evs: EventInput[],
): Drive {
  installDrive(tx, { driveId: drive.id, slotId, ...o }, evs);
  return getDrive(tx, drive.id);
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

/**
 * spare -> installed (R8, R35, R37) inside the caller's transaction; appends the events and leaves
 * the activity to the caller. An occupied slot is never silently replaced.
 */
export function assignInto(
  tx: Tx,
  input: AssignDriveInput,
  clock: Date,
  evs: EventInput[],
): AssignDriveResult {
  const installedOn = installedOnOf(input.installedOn, clock);
  const drive = getDrive(tx, input.driveId);
  if (drive.status === 'retired') throw invalid('Retired drives cannot be assigned');
  if (drive.status === 'installed') {
    throw conflict(`Drive ${drive.id} is installed; remove it from its current slot first`);
  }
  const info = slotInfo(tx, input.slotId);
  const defaults = defaultsFor(tx, input.slotId);
  const occupant = driveInSlot(tx, input.slotId);

  let displaced: Drive | undefined;
  if (occupant) {
    if (!input.occupant) throw occupiedError(info, occupant);
    displaced = resolveOccupant(tx, occupant, input.occupant, installedOn, evs);
  }

  const { poolId, role } = resolvePoolRole(tx, input.poolId, input.role, defaults);
  const updated = placeSpare(tx, drive, input.slotId, { poolId, role, installedOn }, evs);
  return displaced ? { drive: updated, occupant: displaced } : { drive: updated };
}

/** spare -> installed (R8, R35, R37): one `assigned` activity, or `replaced` when the bay was occupied. */
export function assignDrive(db: AppDb, input: AssignDriveInput): AssignDriveResult {
  const clock = new Date();
  const installedOn = installedOnOf(input.installedOn, clock); // 400 before anything is touched
  return db.transaction((tx) => {
    const evs: EventInput[] = [];
    const result = assignInto(tx, { ...input, installedOn }, clock, evs);
    recordActivity(tx, {
      kind: result.occupant ? 'replaced' : 'assigned',
      occurredOn: installedOn,
      events: evs,
    });
    return result;
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
  return db.transaction((tx) => {
    const evs: EventInput[] = [];
    freeSlot(tx, getDrive(tx, driveId), { removedOn, backdate: true }, evs);
    recordActivity(tx, {
      kind: 'removed',
      occurredOn: removedOn,
      note: opts.note ?? null,
      events: evs,
    });
    return getDrive(tx, driveId);
  });
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
  return db.transaction((tx) => {
    const evs: EventInput[] = [];
    const drive = retireInternal(
      tx,
      driveId,
      { reason: opts.reason, date, note: opts.note ?? null },
      evs,
    );
    recordActivity(tx, { kind: 'retired', occurredOn: date, events: evs });
    return drive;
  });
}

/** Retire as failed with a single drive-sent-for-rma event (R27). */
export function sendForRma(
  db: AppDb,
  driveId: string,
  opts: { date?: string | null | undefined; note?: string | null | undefined } = {},
): Drive {
  const date = retirementDateOf(opts.date, new Date());
  return db.transaction((tx) => {
    const evs: EventInput[] = [];
    const drive = rmaInternal(tx, driveId, date, opts.note ?? null, evs);
    recordActivity(tx, { kind: 'sent-for-rma', occurredOn: date, events: evs });
    return drive;
  });
}

/** retired -> spare (R61). The earlier retirement stays in the log: the event holds the fields it cleared. */
export function reinstateDrive(
  db: AppDb,
  driveId: string,
  opts: { note?: string | null | undefined } = {},
): Drive {
  return db.transaction((tx) => {
    const drive = getDrive(tx, driveId);
    if (drive.status !== 'retired') {
      throw conflict(`Drive ${drive.id} is not retired (${drive.status})`);
    }
    tx.update(drives)
      .set({
        retirementReason: null,
        retirementDate: null,
        retirementNote: null,
        updatedAt: nowIso(),
      })
      .where(eq(drives.id, drive.id))
      .run();
    recordActivity(tx, {
      kind: 'reinstated',
      note: opts.note ?? null,
      events: [
        {
          type: 'drive-reinstated',
          driveId: drive.id,
          payload: {
            previousReason: drive.retirementReason,
            previousDate: drive.retirementDate,
            previousNote: drive.retirementNote,
          },
        },
      ],
    });
    return getDrive(tx, driveId);
  });
}
