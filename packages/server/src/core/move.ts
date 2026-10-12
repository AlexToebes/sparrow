import type { Drive, MoveDriveInput, OccupantResolution } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { recordActivity, type DbTransaction, type EventInput } from './activities.js';
import {
  defaultsFor,
  freeSlot,
  occupiedError,
  placeSpare,
  resolveOccupant,
  resolvePoolRole,
  retireInternal,
  rmaInternal,
  slotInfo,
} from './assignment.js';
import { driveInSlot, getDrive } from './drives.js';
import { conflict, invalid } from './errors.js';
import { installDrive, installationOfDrive, uninstallDrive } from './installations.js';
import { parseNotFutureDate, todayUtc } from './installed-on.js';

// R73: one Move for an installed drive. It composes the slot-freeing, retiring, RMA and install
// steps in ONE transaction and records ONE activity, however many bays it touches (R14): `moved`
// for every outcome, or `swapped` when two installed drives trade bays. The drive that moves between
// bays keeps its pool and role (the installation is deleted and re-created in the new bay with the
// same ones), so the log shows an uninstall and an install, never a pool event.

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
    const evs: EventInput[] = [];
    const swapped =
      input.destination.kind === 'slot' && input.destination.occupant?.action === 'swap';
    const result = swapped
      ? swapInto(tx, driveId, input, date, evs)
      : moveInto(tx, driveId, input, date, clock, evs);
    recordActivity(tx, { kind: swapped ? 'swapped' : 'moved', occurredOn: date, events: evs });
    return result;
  });
}

function moveInto(
  tx: Tx,
  driveId: string,
  input: MoveDriveInput,
  date: string | null,
  clock: Date,
  evs: EventInput[],
): MoveDriveResult {
  const drive = getDrive(tx, driveId);
  if (drive.status !== 'installed' || drive.slotId === null) {
    throw conflict(`Drive ${drive.id} is not installed (${drive.status})`);
  }
  const sourceSlotId = drive.slotId;
  slotInfo(tx, sourceSlotId);

  // Validate the replacement and read the R35 defaults before anything is written. The defaults
  // come from the bay being vacated, whose live installation is this drive's.
  const spare = input.replacement ? getDrive(tx, input.replacement.driveId) : null;
  if (spare) {
    if (spare.id === drive.id) throw invalid('A drive cannot take its own place');
    if (spare.status === 'retired') throw invalid('Retired drives cannot be assigned');
    if (spare.status === 'installed') {
      throw conflict(`Drive ${spare.id} is installed; remove it from its current slot first`);
    }
  }
  const defaults = defaultsFor(tx, sourceSlotId);

  const dest = input.destination;
  let moved: Drive;
  let occupantAfter: Drive | undefined;
  if (dest.kind === 'slot') {
    if (dest.slotId === sourceSlotId) throw invalid('The drive is already in that bay');
    const targetInfo = slotInfo(tx, dest.slotId);
    const occupant = driveInSlot(tx, dest.slotId);
    if (occupant) {
      if (!dest.occupant) throw occupiedError(targetInfo, occupant);
      // The occupant leaves on the move date too (one physical act, R73).
      const resolution: OccupantResolution = dest.occupant as OccupantResolution;
      occupantAfter = resolveOccupant(tx, occupant, resolution, date, evs);
    }
    moved = moveBetweenBays(tx, drive, dest.slotId, date, evs);
  } else if (dest.kind === 'spares') {
    freeSlot(tx, drive, { removedOn: date, backdate: true }, evs);
    moved = getDrive(tx, drive.id);
  } else if (dest.kind === 'retire') {
    moved = retireInternal(
      tx,
      drive.id,
      { reason: dest.reason, date, note: dest.note ?? null },
      evs,
    );
  } else {
    moved = rmaInternal(tx, drive.id, date, dest.note ?? null, evs);
  }

  let replacement: Drive | undefined;
  if (spare && input.replacement) {
    const { poolId, role } = resolvePoolRole(
      tx,
      input.replacement.poolId,
      input.replacement.role,
      defaults,
    );
    replacement = placeSpare(tx, spare, sourceSlotId, { poolId, role, installedOn: date }, evs);
  }
  return {
    drive: moved,
    ...(occupantAfter ? { occupant: occupantAfter } : {}),
    ...(replacement ? { replacement } : {}),
  };
}

/**
 * installed in bay A -> installed in (empty) bay B. Moving within the NAS does not change the pool
 * (R29): the installation is deleted and re-created in B with the same pool and role. The
 * installation date restarts at the move date (null = not recorded).
 */
function moveBetweenBays(
  tx: Tx,
  drive: Drive,
  toSlotId: string,
  date: string | null,
  evs: EventInput[],
): Drive {
  if (date !== null && drive.installedOn !== null && date < drive.installedOn) {
    throw invalid(
      `A drive can't be moved before it was installed (installed on ${drive.installedOn})`,
    );
  }
  const from = installationOfDrive(tx, drive.id)!;
  uninstallDrive(tx, from, evs);
  installDrive(
    tx,
    {
      driveId: drive.id,
      slotId: toSlotId,
      poolId: from.poolId,
      role: from.poolRole,
      installedOn: date,
    },
    evs,
  );
  return getDrive(tx, drive.id);
}

/**
 * R73: two installed drives trade bays in one transaction. Both keep their pool and role: each
 * installation is deleted and re-created in the other's bay, so the activity holds two
 * drive-uninstalled and two drive-installed events.
 */
function swapInto(
  tx: Tx,
  driveId: string,
  input: MoveDriveInput,
  date: string | null,
  evs: EventInput[],
): MoveDriveResult {
  const a = getDrive(tx, driveId);
  if (a.status !== 'installed' || a.slotId === null) {
    throw conflict(`Drive ${a.id} is not installed (${a.status})`);
  }
  if (input.replacement) throw invalid('A swap fills the vacated bay itself; give no replacement');
  if (input.destination.kind !== 'slot') throw invalid('Unreachable swap');
  const targetSlotId = input.destination.slotId;
  slotInfo(tx, a.slotId);
  if (targetSlotId === a.slotId) throw invalid('The drive is already in that bay');
  const bInfo = slotInfo(tx, targetSlotId);
  const b = driveInSlot(tx, targetSlotId);
  if (!b) throw invalid(`Bay ${bInfo.slotLabel} is empty; there is no drive to swap with`);
  for (const d of [a, b]) {
    if (date !== null && d.installedOn !== null && date < d.installedOn) {
      throw invalid(
        `${d.serial} can't be moved before it was installed (installed on ${d.installedOn})`,
      );
    }
  }
  const rowA = installationOfDrive(tx, a.id)!;
  const rowB = installationOfDrive(tx, b.id)!;
  uninstallDrive(tx, rowA, evs);
  uninstallDrive(tx, rowB, evs);
  installDrive(
    tx,
    {
      driveId: a.id,
      slotId: rowB.slotId,
      poolId: rowA.poolId,
      role: rowA.poolRole,
      installedOn: date,
    },
    evs,
  );
  installDrive(
    tx,
    {
      driveId: b.id,
      slotId: rowA.slotId,
      poolId: rowB.poolId,
      role: rowB.poolRole,
      installedOn: date,
    },
    evs,
  );
  return { drive: getDrive(tx, a.id), occupant: getDrive(tx, b.id) };
}
