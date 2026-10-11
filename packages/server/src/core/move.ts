import { eq } from 'drizzle-orm';
import type { Drive, MoveDriveInput, OccupantResolution } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { drives } from '../db/schema.js';
import {
  defaultsFor,
  freeSlot,
  loadDrive,
  occupiedError,
  outgoingPayload,
  placeSpare,
  resolveOccupant,
  resolvePoolRole,
  retireInternal,
  rmaInternal,
  slotInfo,
  type Outgoing,
  type PoolRef,
} from './assignment.js';
import { conflict, invalid } from './errors.js';
import { recordEvent, type DbTransaction } from './events.js';
import { parseNotFutureDate, todayUtc } from './installed-on.js';
import { openMembership } from './memberships.js';

// R73: one Move for an installed drive. It composes the existing slot-freeing, retiring, RMA and
// install steps in ONE transaction, so a failure anywhere leaves nothing changed (R14). One real
// action is one event: a move to an empty bay is drive-moved, a swap is drives-swapped, and a drive
// arriving in an occupied bay (or a spare taking the bay the mover vacated) is drive-replaced.

type Tx = DbTransaction;

export interface MoveDriveResult {
  /** The drive that moved, as it is now. */
  drive: Drive;
  /** The former occupant of the destination bay after it was resolved, when there was one. */
  occupant?: Drive;
  /** The spare that took the vacated bay, when one was given. */
  replacement?: Drive;
}

/** Installed drive -> spares | another bay | retired | RMA, optionally with a spare into its bay. */
export function moveDrive(db: AppDb, driveId: string, input: MoveDriveInput): MoveDriveResult {
  const clock = new Date();
  // The one date of the move: omitted = today (UTC); null = not recorded; future = 400.
  const date =
    input.date === undefined
      ? todayUtc(clock)
      : input.date === null
        ? null
        : parseNotFutureDate('date', input.date, clock);

  return db.transaction((tx) => {
    const drive = loadDrive(tx, driveId);
    if (drive.status !== 'installed' || drive.slotId === null) {
      throw conflict(`Drive ${drive.id} is not installed (${drive.status})`);
    }
    const sourceSlotId = drive.slotId;
    const sourceInfo = slotInfo(tx, sourceSlotId);
    if (input.replacement && input.destination.kind === 'slot') {
      if (input.destination.occupant?.action === 'swap') {
        throw invalid('A swap fills the vacated bay itself; give no replacement');
      }
    }

    // Validate the replacement and read the R35 defaults before anything is written. The defaults
    // come from the bay being vacated, whose live membership is this drive's.
    const spare = input.replacement ? loadDrive(tx, input.replacement.driveId) : null;
    if (spare) {
      if (spare.id === drive.id) throw invalid('A drive cannot take its own place');
      if (spare.status === 'retired') throw invalid('Retired drives cannot be assigned');
      if (spare.status === 'installed') {
        throw conflict(`Drive ${spare.id} is installed; remove it from its current slot first`);
      }
    }
    const defaults = defaultsFor(tx, sourceSlotId);

    const dest = input.destination;
    if (dest.kind === 'slot' && dest.occupant?.action === 'swap') {
      return swapDrives(tx, drive, sourceInfo, dest.slotId, date);
    }
    // What the vacated bay's event will say about the mover, when a spare takes that bay.
    let mover: Outgoing | undefined;
    let moved: Drive;
    let occupantAfter: Drive | undefined;
    let toSlotId: string | null = null;
    if (dest.kind === 'slot') {
      if (dest.slotId === sourceSlotId) throw invalid('The drive is already in that bay');
      const targetInfo = slotInfo(tx, dest.slotId);
      const occupant = tx.select().from(drives).where(eq(drives.slotId, dest.slotId)).get();
      let displaced: Outgoing | undefined;
      if (occupant) {
        if (!dest.occupant) throw occupiedError(targetInfo, occupant);
        // The occupant's own dates are the move date unless the request gave one.
        const resolution = dest.occupant;
        if (resolution.action === 'swap') throw invalid('Unreachable swap'); // handled above
        displaced = resolveOccupant(tx, occupant, resolution, clock, date);
        occupantAfter = displaced.drive;
      }
      const step = moveBetweenBays(tx, drive, dest.slotId, date);
      moved = step.drive;
      toSlotId = dest.slotId;
      mover = {
        drive: moved,
        outcome: 'moved',
        date,
        toSlotId: dest.slotId,
        pool: step.pool,
        installedOn: step.installedOnBefore,
      };
      if (displaced) {
        // The mover arrives in an occupied bay: one drive-replaced event for that bay. When no spare
        // fills the vacated bay, the same event links it as `from`, so its history sees the mover leave.
        recordEvent(tx, {
          type: 'drive-replaced',
          drives: [
            { id: displaced.drive.id, role: 'outgoing' },
            { id: moved.id, role: 'incoming' },
          ],
          slots: [
            { id: dest.slotId, role: 'at' },
            ...(spare ? [] : [{ id: sourceSlotId, role: 'from' as const }]),
          ],
          payload: {
            installedOn: date,
            ...step.pool,
            outgoing: outgoingPayload(displaced),
          },
        });
      } else if (!spare) {
        recordEvent(tx, {
          type: 'drive-moved',
          drives: [{ id: moved.id }],
          slots: [
            { id: sourceSlotId, role: 'from' },
            { id: dest.slotId, role: 'to' },
          ],
          payload: {
            date,
            ...step.pool,
            installedOn: step.installedOnBefore,
          },
        });
      }
    } else if (spare) {
      // A spare takes the vacated bay: the departure and the arrival are the one drive-replaced event.
      const resolution: OccupantResolution =
        dest.kind === 'spares'
          ? { action: 'spare', removedOn: date }
          : dest.kind === 'retire'
            ? { action: 'retire', reason: dest.reason, date, note: dest.note }
            : { action: 'rma', date, note: dest.note };
      mover = resolveOccupant(tx, drive, resolution, clock, date);
      moved = mover.drive;
    } else if (dest.kind === 'spares') {
      moved = freeSlot(tx, drive, null, { removedOn: date, backdate: true });
    } else if (dest.kind === 'retire') {
      moved = retireInternal(tx, drive.id, {
        reason: dest.reason,
        date,
        note: dest.note ?? null,
      });
    } else {
      moved = rmaInternal(tx, drive.id, date, dest.note ?? null);
    }

    let replacement: Drive | undefined;
    if (spare && input.replacement && mover) {
      const { poolId, role } = resolvePoolRole(
        tx,
        input.replacement.poolId,
        input.replacement.role,
        defaults,
      );
      replacement = placeSpare(tx, spare, sourceSlotId, {
        poolId,
        role,
        installedOn: date,
        replaced: mover,
        extraSlots: toSlotId === null ? [] : [{ id: toSlotId, role: 'to' }],
      });
    }
    return {
      drive: moved,
      ...(occupantAfter ? { occupant: occupantAfter } : {}),
      ...(replacement ? { replacement } : {}),
    };
  });
}

/**
 * installed in bay A -> installed in (empty) bay B. Moving within the NAS does not change pool
 * membership (R29): the open membership is left alone and no pool-left / pool-joined events are
 * written. The installation date restarts at the move date (null = not recorded). Changes the drive
 * only; the caller writes the one event that describes the move.
 */
function moveBetweenBays(
  tx: Tx,
  drive: Drive,
  toSlotId: string,
  date: string | null,
): { drive: Drive; pool: PoolRef; installedOnBefore: string | null } {
  if (date !== null && drive.installedOn !== null && date < drive.installedOn) {
    throw invalid(
      `A drive can't be moved before it was installed (installed on ${drive.installedOn})`,
    );
  }
  const at = new Date().toISOString();
  const open = openMembership(tx, drive.id);
  const pool = { poolId: open?.poolId ?? null, role: open?.role ?? null };
  const updated = tx
    .update(drives)
    .set({ slotId: toSlotId, installedOn: date, updatedAt: at })
    .where(eq(drives.id, drive.id))
    .returning()
    .get();
  return { drive: updated, pool, installedOnBefore: drive.installedOn };
}

/**
 * R73: two installed drives trade bays in one transaction. Both keep their pool memberships (no pool
 * events); each gets a drive-removed and a drive-installed event naming the other. The unique slot
 * index (D7) is checked row by row and the CHECKs tie slot_id to status 'installed', so the swap goes
 * through a legal intermediate state: A is parked as a spare without a bay, B takes A's bay, then A
 * is installed in B's old bay. Only the final state is visible outside the transaction.
 */
function swapDrives(
  tx: Tx,
  a: Drive,
  aInfo: ReturnType<typeof slotInfo>,
  targetSlotId: string,
  date: string | null,
): MoveDriveResult {
  if (targetSlotId === aInfo.slotId) throw invalid('The drive is already in that bay');
  const bInfo = slotInfo(tx, targetSlotId);
  const found = tx.select().from(drives).where(eq(drives.slotId, targetSlotId)).get();
  if (!found) throw invalid(`Bay ${bInfo.slotLabel} is empty; there is no drive to swap with`);
  const b = loadDrive(tx, found.id);
  if (b.status !== 'installed' || b.slotId === null) {
    throw conflict(`Drive ${b.id} is not installed (${b.status})`);
  }
  for (const d of [a, b]) {
    if (date !== null && d.installedOn !== null && date < d.installedOn) {
      throw invalid(
        `${d.serial} can't be moved before it was installed (installed on ${d.installedOn})`,
      );
    }
  }
  const at = new Date().toISOString();
  const set = (id: string, values: Partial<typeof drives.$inferInsert>) =>
    tx
      .update(drives)
      .set({ ...values, updatedAt: at })
      .where(eq(drives.id, id))
      .returning()
      .get();
  const poolOf = (id: string) => {
    const open = openMembership(tx, id);
    return { poolId: open?.poolId ?? null, role: open?.role ?? null };
  };
  const poolA = poolOf(a.id);
  const poolB = poolOf(b.id);

  set(a.id, { status: 'spare', slotId: null, installedOn: null });
  set(b.id, { slotId: aInfo.slotId, installedOn: date });
  const movedA = set(a.id, { status: 'installed', slotId: bInfo.slotId, installedOn: date });
  const movedB = loadDrive(tx, b.id);

  const move = (d: Drive, from: ReturnType<typeof slotInfo>, to: ReturnType<typeof slotInfo>) => {
    const pool = d.id === a.id ? poolA : poolB;
    return {
      driveId: d.id,
      fromSlotId: from.slotId,
      toSlotId: to.slotId,
      ...pool,
      installedOn: d.installedOn,
    };
  };
  recordEvent(tx, {
    type: 'drives-swapped',
    at,
    drives: [{ id: a.id }, { id: b.id }],
    slots: [
      { id: aInfo.slotId, role: 'from' },
      { id: aInfo.slotId, role: 'to' },
      { id: bInfo.slotId, role: 'from' },
      { id: bInfo.slotId, role: 'to' },
    ],
    payload: { date, moves: [move(a, aInfo, bInfo), move(b, bInfo, aInfo)] },
  });
  return { drive: movedA, occupant: movedB };
}
