import { randomUUID } from 'node:crypto';
import { and, desc, eq, isNull, sql } from 'drizzle-orm';
import type { ChangeMembershipInput, JoinPoolInput, MembershipRole } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { drives, memberships, pools } from '../db/schema.js';
import { conflict, notFound } from './errors.js';
import { recordEvent, type DbTransaction } from './events.js';

// Pool membership (R29, R33, R35, R36). The membership helpers at the top are shared with the
// assignment flows (Step 7): assignment opens a membership on install and ends it on remove or
// retire, through these functions, so the event shapes stay identical. Every public function runs
// in ONE transaction with its events (R14). Source is always 'manual' in the MVP (R31).

export type Membership = typeof memberships.$inferSelect;
type Tx = DbTransaction;

const nowIso = () => new Date().toISOString();

/** Normalizes a timestamp to the stored UTC form so string comparisons with other rows hold. */
const toIso = (value: string | undefined): string | undefined =>
  value === undefined ? undefined : new Date(value).toISOString();

export function loadDriveRow(tx: Tx, id: string) {
  const row = tx.select().from(drives).where(eq(drives.id, id)).get();
  if (!row) throw notFound(`Drive ${id} not found`);
  return row;
}

export function requirePool(tx: Tx, id: string) {
  const row = tx.select().from(pools).where(eq(pools.id, id)).get();
  if (!row) throw notFound(`Pool ${id} not found`);
  return row;
}

/** The drive's open membership (one at most, D7-style guarantee from the partial unique index). */
export function openMembership(tx: Tx, driveId: string): Membership | undefined {
  return tx
    .select()
    .from(memberships)
    .where(and(eq(memberships.driveId, driveId), isNull(memberships.endedAt)))
    .get();
}

/** Ends the drive's open membership (history kept) and logs pool-left. Returns what it ended. */
export function endOpenMembership(
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

/** Opens a manual membership and logs pool-joined (R33). The caller decides the time and slot. */
export function startMembership(
  tx: Tx,
  input: {
    driveId: string;
    poolId: string;
    role: MembershipRole;
    startedAt: string;
    slotId: string | null;
  },
): Membership {
  const id = randomUUID();
  const row = tx
    .insert(memberships)
    .values({
      id,
      driveId: input.driveId,
      poolId: input.poolId,
      role: input.role,
      source: 'manual',
      startedAt: input.startedAt,
      endedAt: null,
      createdAt: nowIso(),
    })
    .returning()
    .get();
  recordEvent(tx, {
    driveId: input.driveId,
    type: 'pool-joined',
    at: input.startedAt,
    payload: { poolId: input.poolId, role: input.role, slotId: input.slotId, membershipId: id },
  });
  return row;
}

/** A drive that is installed in a slot may join a pool (R33: spares and retired drives may not). */
function requireInstalled(drive: typeof drives.$inferSelect): void {
  if (drive.status !== 'installed' || drive.slotId === null) {
    throw conflict(`Drive ${drive.id} must be installed to join a pool (${drive.status})`);
  }
}

/** spare-free join: adds the drive to a pool with an open membership. */
export function joinPool(db: AppDb, driveId: string, input: JoinPoolInput): Membership {
  return db.transaction((tx) => {
    const drive = loadDriveRow(tx, driveId);
    requireInstalled(drive);
    requirePool(tx, input.poolId);
    const open = openMembership(tx, driveId);
    if (open) {
      throw conflict(`Drive ${driveId} is already in a pool; change its membership instead`);
    }
    return startMembership(tx, {
      driveId,
      poolId: input.poolId,
      role: input.role ?? 'data',
      startedAt: toIso(input.startedAt) ?? nowIso(),
      slotId: drive.slotId,
    });
  });
}

/**
 * Edits the open membership (R36). A role change on the same pool keeps the row and its start date
 * and logs pool-role-changed. A different pool ends the current membership and opens a new one.
 * With no pool given the role defaults to the current one.
 */
export function changeMembership(
  db: AppDb,
  driveId: string,
  input: ChangeMembershipInput,
): Membership {
  return db.transaction((tx) => {
    const drive = loadDriveRow(tx, driveId);
    const open = openMembership(tx, driveId);
    if (!open) {
      throw conflict(`Drive ${driveId} is not in a pool; join one first`);
    }
    const targetPoolId = input.poolId ?? open.poolId;
    const targetRole = input.role ?? open.role;
    if (targetPoolId === open.poolId && targetRole === open.role) return open;

    if (targetPoolId !== open.poolId) {
      requirePool(tx, targetPoolId);
      requireInstalled(drive);
      const at = nowIso();
      endOpenMembership(tx, driveId, at);
      return startMembership(tx, {
        driveId,
        poolId: targetPoolId,
        role: targetRole,
        startedAt: at,
        slotId: drive.slotId,
      });
    }

    tx.update(memberships).set({ role: targetRole }).where(eq(memberships.id, open.id)).run();
    recordEvent(tx, {
      driveId,
      type: 'pool-role-changed',
      payload: {
        poolId: open.poolId,
        from: open.role,
        to: targetRole,
        membershipId: open.id,
      },
    });
    return tx.select().from(memberships).where(eq(memberships.id, open.id)).get()!;
  });
}

/** Ends the open membership (R29). The row stays as history. */
export function leavePool(
  db: AppDb,
  driveId: string,
  opts: { endedAt?: string | undefined } = {},
): Membership {
  return db.transaction((tx) => {
    loadDriveRow(tx, driveId);
    const open = openMembership(tx, driveId);
    if (!open) throw conflict(`Drive ${driveId} is not in a pool`);
    endOpenMembership(tx, driveId, toIso(opts.endedAt) ?? nowIso());
    return tx.select().from(memberships).where(eq(memberships.id, open.id)).get()!;
  });
}

/** Full membership history for a drive, newest first. */
export function listMemberships(db: AppDb, driveId: string): Membership[] {
  return db.transaction((tx) => {
    loadDriveRow(tx, driveId);
    return tx
      .select()
      .from(memberships)
      .where(eq(memberships.driveId, driveId))
      .orderBy(desc(memberships.startedAt), desc(sql`rowid`))
      .all();
  });
}
