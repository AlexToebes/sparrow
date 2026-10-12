import { eq } from 'drizzle-orm';
import type { ChangeMembershipInput, JoinPoolInput, MembershipRole } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { installations, pools } from '../db/schema.js';
import { recordActivity, type DbTransaction, type EventInput } from './activities.js';
import { getDrive } from './drives.js';
import { conflict, invalid, notFound } from './errors.js';
import { installationOfDrive, type InstallationRow } from './installations.js';

// Pool membership (R29, R33, R35, R36) is the pool and role of a drive's installation. Joining,
// leaving, moving to another pool and changing the role edit that row, and each action records ONE
// activity of the matching kind. Installing and uninstalling a drive set or clear the pool as part of
// their own events (installations.ts), so they never write pool events. The user's date, when given,
// becomes the activity's occurred-on day.

type Tx = DbTransaction;

/** Allowed clock skew between the browser that sends a date and this server. */
const FUTURE_TOLERANCE_MS = 5 * 60_000;

/** Rejects a user-supplied date that lies in the future (beyond a little clock skew). */
function assertNotFuture(iso: string | undefined, field: 'startedAt' | 'endedAt'): void {
  if (iso !== undefined && Date.parse(iso) > Date.now() + FUTURE_TOLERANCE_MS) {
    throw invalid(`${field} must not be in the future`);
  }
}

const dayOf = (iso: string | undefined): string | null =>
  iso === undefined ? null : new Date(iso).toISOString().slice(0, 10);

export function requirePool(tx: Tx, id: string) {
  const row = tx.select().from(pools).where(eq(pools.id, id)).get();
  if (!row) throw notFound(`Pool ${id} not found`);
  return row;
}

/** The installation of an installed drive; spares and retired drives may not be in a pool (R33). */
function requireInstallation(tx: Tx, driveId: string): InstallationRow {
  const drive = getDrive(tx, driveId);
  const row = installationOfDrive(tx, driveId);
  if (!row) {
    throw conflict(`Drive ${driveId} must be installed to join a pool (${drive.status})`);
  }
  return row;
}

const setPool = (
  tx: Tx,
  row: InstallationRow,
  poolId: string | null,
  role: MembershipRole | null,
): InstallationRow =>
  tx
    .update(installations)
    .set({ poolId, poolRole: role })
    .where(eq(installations.driveId, row.driveId))
    .returning()
    .get();

const joined = (row: InstallationRow): EventInput => ({
  type: 'pool-joined',
  driveId: row.driveId,
  slotId: row.slotId,
  poolId: row.poolId,
  payload: { poolRole: row.poolRole },
});

const left = (row: InstallationRow): EventInput => ({
  type: 'pool-left',
  driveId: row.driveId,
  slotId: row.slotId,
  poolId: row.poolId,
  payload: { poolRole: row.poolRole },
});

/** Adds the installed drive to a pool (R29, R33); a drive is in at most one pool. */
export function joinPool(db: AppDb, driveId: string, input: JoinPoolInput): InstallationRow {
  assertNotFuture(input.startedAt, 'startedAt');
  return db.transaction((tx) => {
    const row = requireInstallation(tx, driveId);
    requirePool(tx, input.poolId);
    if (row.poolId !== null) {
      throw conflict(`Drive ${driveId} is already in a pool; change its membership instead`);
    }
    const next = setPool(tx, row, input.poolId, input.role ?? 'data');
    recordActivity(tx, {
      kind: 'pool-joined',
      occurredOn: dayOf(input.startedAt),
      events: [joined(next)],
    });
    return next;
  });
}

/**
 * Edits the drive's pool and role (R36). A role change on the same pool is one pool-role-changed
 * event. A different pool is a pool-left and a pool-joined event in ONE `pool-changed` activity.
 * With no pool given the role defaults to the current one.
 */
export function changeMembership(
  db: AppDb,
  driveId: string,
  input: ChangeMembershipInput,
): InstallationRow {
  return db.transaction((tx) => {
    getDrive(tx, driveId);
    const row = installationOfDrive(tx, driveId);
    if (!row || row.poolId === null || row.poolRole === null) {
      throw conflict(`Drive ${driveId} is not in a pool; join one first`);
    }
    const targetPoolId = input.poolId ?? row.poolId;
    const targetRole = input.role ?? row.poolRole;
    if (targetPoolId === row.poolId && targetRole === row.poolRole) return row;

    if (targetPoolId !== row.poolId) {
      requirePool(tx, targetPoolId);
      const events: EventInput[] = [left(row)];
      const next = setPool(tx, row, targetPoolId, targetRole);
      events.push(joined(next));
      recordActivity(tx, { kind: 'pool-changed', events });
      return next;
    }

    const next = setPool(tx, row, row.poolId, targetRole);
    recordActivity(tx, {
      kind: 'pool-role-changed',
      events: [
        {
          type: 'pool-role-changed',
          driveId,
          slotId: row.slotId,
          poolId: row.poolId,
          payload: { from: row.poolRole, to: targetRole },
        },
      ],
    });
    return next;
  });
}

/** Takes the drive out of its pool (R29). The installation stays; the log keeps the history. */
export function leavePool(
  db: AppDb,
  driveId: string,
  opts: { endedAt?: string | undefined } = {},
): InstallationRow {
  assertNotFuture(opts.endedAt, 'endedAt');
  return db.transaction((tx) => {
    const row = installationOfDrive(tx, driveId);
    getDrive(tx, driveId);
    if (!row || row.poolId === null) throw conflict(`Drive ${driveId} is not in a pool`);
    const next = setPool(tx, row, null, null);
    recordActivity(tx, {
      kind: 'pool-left',
      occurredOn: dayOf(opts.endedAt),
      events: [left(row)],
    });
    return next;
  });
}
