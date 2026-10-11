import { randomUUID } from 'node:crypto';
import { and, asc, eq, isNull, ne } from 'drizzle-orm';
import type { CreatePoolInput, Pool, UpdatePoolInput } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { drives, memberships, pools, slots } from '../db/schema.js';
import { conflict, invalid } from './errors.js';
import { requirePool } from './memberships.js';

// Pool records (R30). Pool CRUD writes no drive events (events are per drive, R14). A pool that has
// ever had a membership cannot be deleted, because the history must stay readable (R29).

export interface PoolSummary extends Pool {
  memberCount: number;
}

export interface PoolMember {
  membershipId: string;
  driveId: string;
  serial: string;
  role: 'data' | 'hot-spare';
  startedAt: string;
  /** The slot's label (or "Slot N") when the drive is installed; always set for open members. */
  slotLabel: string | null;
}

export interface PoolDetail extends PoolSummary {
  members: PoolMember[];
}

const nowIso = () => new Date().toISOString();

function requireName(name: string): string {
  const trimmed = name.trim();
  if (trimmed.length === 0) throw invalid('Pool name is required');
  return trimmed;
}

function assertNameFree(
  tx: Parameters<Parameters<AppDb['transaction']>[0]>[0],
  name: string,
  exceptId?: string,
) {
  const clash = tx
    .select({ id: pools.id })
    .from(pools)
    .where(exceptId ? and(eq(pools.name, name), ne(pools.id, exceptId)) : eq(pools.name, name))
    .get();
  if (clash) throw conflict(`A pool named "${name}" already exists`, { poolId: clash.id });
}

export function createPool(db: AppDb, input: CreatePoolInput): Pool {
  return db.transaction((tx) => {
    const name = requireName(input.name);
    assertNameFree(tx, name);
    const at = nowIso();
    return tx
      .insert(pools)
      .values({
        id: randomUUID(),
        name,
        layoutLabel: input.layoutLabel ?? null,
        expectedMembers: input.expectedMembers ?? null,
        createdAt: at,
        updatedAt: at,
      })
      .returning()
      .get();
  });
}

/** Renames or relabels a pool. Memberships are untouched (they reference the pool by ID). */
export function updatePool(db: AppDb, id: string, input: UpdatePoolInput): Pool {
  return db.transaction((tx) => {
    const current = requirePool(tx, id);
    const set: {
      name?: string;
      layoutLabel?: string | null;
      expectedMembers?: number | null;
      updatedAt: string;
    } = {
      updatedAt: nowIso(),
    };
    if (input.name !== undefined) {
      const name = requireName(input.name);
      if (name !== current.name) assertNameFree(tx, name, id);
      set.name = name;
    }
    if (input.layoutLabel !== undefined) set.layoutLabel = input.layoutLabel;
    if (input.expectedMembers !== undefined) set.expectedMembers = input.expectedMembers;
    return tx.update(pools).set(set).where(eq(pools.id, id)).returning().get();
  });
}

function memberCounts(db: AppDb): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of db
    .select({ poolId: memberships.poolId })
    .from(memberships)
    .where(isNull(memberships.endedAt))
    .all()) {
    counts.set(row.poolId, (counts.get(row.poolId) ?? 0) + 1);
  }
  return counts;
}

export function listPools(db: AppDb): PoolSummary[] {
  const counts = memberCounts(db);
  return db
    .select()
    .from(pools)
    .orderBy(asc(pools.name))
    .all()
    .map((p) => ({ ...p, memberCount: counts.get(p.id) ?? 0 }));
}

/** A pool with its current members (open memberships), ordered by serial. */
export function getPool(db: AppDb, id: string): PoolDetail {
  return db.transaction((tx) => {
    const pool = requirePool(tx, id);
    const rows = tx
      .select({
        membershipId: memberships.id,
        driveId: drives.id,
        serial: drives.serial,
        serialNormalized: drives.serialNormalized,
        role: memberships.role,
        startedAt: memberships.startedAt,
        slotLabel: slots.label,
        slotPosition: slots.position,
      })
      .from(memberships)
      .innerJoin(drives, eq(drives.id, memberships.driveId))
      .leftJoin(slots, eq(slots.id, drives.slotId))
      .where(and(eq(memberships.poolId, id), isNull(memberships.endedAt)))
      .orderBy(asc(drives.serialNormalized))
      .all();
    const members: PoolMember[] = rows.map((r) => ({
      membershipId: r.membershipId,
      driveId: r.driveId,
      serial: r.serial,
      role: r.role,
      startedAt: r.startedAt,
      slotLabel: r.slotPosition === null ? null : (r.slotLabel ?? `Slot ${r.slotPosition + 1}`),
    }));
    return { ...pool, memberCount: members.length, members };
  });
}

/** Deletes a pool only when it has never had a membership (R29: history must be preserved). */
export function deletePool(db: AppDb, id: string): void {
  db.transaction((tx) => {
    requirePool(tx, id);
    const used = tx
      .select({ id: memberships.id })
      .from(memberships)
      .where(eq(memberships.poolId, id))
      .get();
    if (used) {
      throw conflict(`Pool ${id} has membership history and cannot be deleted`);
    }
    tx.delete(pools).where(eq(pools.id, id)).run();
  });
}
