import { eq } from 'drizzle-orm';
import type { MembershipRole } from '@sparrow/shared';
import { installations } from '../db/schema.js';
import type { DbTransaction, EventInput, Reader } from './activities.js';
import { getDrive } from './drives.js';
import { invalid } from './errors.js';

// R29, D7: the installation is the relationship between a drive and the bay it sits in; the pool and
// the pool role are its properties. These two functions are the only ones that create or delete the
// row, and each appends the event that says so. The row is fully described by the event's drive, slot
// and pool columns, the payload's pool role and the activity's date: `drive-installed` creates it
// (installed-on = the activity's occurred-on day), and `drive-uninstalled` deletes it, carrying the
// OLD values needed to undo it (installed-on, pool role; the pool is the event's pool). The removal
// day is the activity's occurred-on day.

export type InstallationRow = typeof installations.$inferSelect;

export const installationOfDrive = (db: Reader, driveId: string): InstallationRow | undefined =>
  db.select().from(installations).where(eq(installations.driveId, driveId)).get();

export const installationInSlot = (db: Reader, slotId: string): InstallationRow | undefined =>
  db.select().from(installations).where(eq(installations.slotId, slotId)).get();

/** The pool and role a drive held in its bay; carried across moves and read for the R35 defaults. */
export interface PoolRef {
  poolId: string | null;
  role: MembershipRole | null;
}

export const poolOf = (row: InstallationRow | undefined): PoolRef => ({
  poolId: row?.poolId ?? null,
  role: row?.poolRole ?? null,
});

/**
 * Puts a drive into a bay: inserts the installation and appends `drive-installed`. `installedOn` must
 * be the day the calling activity records as its occurred-on (null = not recorded). A retired drive
 * cannot be installed (the baseline SQL has a trigger as a backstop).
 */
export function installDrive(
  tx: DbTransaction,
  o: {
    driveId: string;
    slotId: string;
    poolId: string | null;
    role: MembershipRole | null;
    installedOn: string | null;
  },
  evs: EventInput[],
): InstallationRow {
  if (getDrive(tx, o.driveId).status === 'retired') {
    throw invalid('Retired drives cannot be assigned');
  }
  const row = tx
    .insert(installations)
    .values({
      driveId: o.driveId,
      slotId: o.slotId,
      poolId: o.poolId,
      poolRole: o.poolId === null ? null : o.role,
      installedOn: o.installedOn,
    })
    .returning()
    .get();
  evs.push({
    type: 'drive-installed',
    driveId: row.driveId,
    slotId: row.slotId,
    poolId: row.poolId,
    payload: { poolRole: row.poolRole },
  });
  return row;
}

/** Takes a drive out of its bay: deletes the installation and appends `drive-uninstalled` with the old installed-on and pool role. */
export function uninstallDrive(tx: DbTransaction, row: InstallationRow, evs: EventInput[]): void {
  tx.delete(installations).where(eq(installations.driveId, row.driveId)).run();
  evs.push({
    type: 'drive-uninstalled',
    driveId: row.driveId,
    slotId: row.slotId,
    poolId: row.poolId,
    payload: { installedOn: row.installedOn, poolRole: row.poolRole },
  });
}
