import { randomUUID } from 'node:crypto';
import { and, asc, eq, ne, sql } from 'drizzle-orm';
import type {
  CreatePoolInput,
  Pool,
  PoolDetail,
  PoolSizeCheck,
  PoolSummary,
  UpdatePoolInput,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { drives, installations, pools, slots } from '../db/schema.js';
import { recordActivity } from './activities.js';
import { conflict, invalid } from './errors.js';
import { requirePool } from './memberships.js';

// Pool records (R30). Pool CRUD records a `pool-edited` activity whose events belong to the pool and
// to no drive (R75). A pool can be deleted when no installation references it; the history keeps its
// name (a snapshot on each event), so deleting never erases it (R29, changed 2026-10-12).

// The response types (PoolSummary, PoolDetail, PoolSizeCheck) are defined once in @sparrow/shared,
// where the web client validates them too.
export type { PoolDetail, PoolSizeCheck, PoolSummary };

/** R34: how the current member count compares with the expected one (null expected = no check). */

export function poolSizeCheck(memberCount: number, expected: number | null): PoolSizeCheck | null {
  if (expected === null) return null;
  return memberCount < expected ? 'fewer' : memberCount > expected ? 'more' : 'ok';
}

const summarize = (pool: Pool, memberCount: number): PoolSummary => ({
  ...pool,
  memberCount,
  sizeCheck: poolSizeCheck(memberCount, pool.expectedMembers),
});

/** A drive installed in a bay that belongs to the pool (the pool is a property of the installation). */
export type PoolMember = PoolDetail['members'][number];

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
    const row = tx
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
    // The whole record, so the log can rebuild it.
    recordActivity(tx, {
      kind: 'pool-edited',
      events: [{ type: 'pool-created', poolId: row.id, payload: { ...row } }],
    });
    return row;
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
    const row = tx.update(pools).set(set).where(eq(pools.id, id)).returning().get();
    const changes: Record<string, { from: unknown; to: unknown }> = {};
    for (const field of ['name', 'layoutLabel', 'expectedMembers'] as const) {
      if (current[field] !== row[field]) changes[field] = { from: current[field], to: row[field] };
    }
    if (Object.keys(changes).length > 0) {
      recordActivity(tx, {
        kind: 'pool-edited',
        events: [{ type: 'pool-updated', poolId: id, payload: { changes } }],
      });
    }
    return row;
  });
}

function memberCounts(db: AppDb): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of db
    .select({ poolId: installations.poolId, n: sql<number>`count(*)` })
    .from(installations)
    .groupBy(installations.poolId)
    .all()) {
    if (row.poolId !== null) counts.set(row.poolId, row.n);
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
    .map((p) => summarize(p, counts.get(p.id) ?? 0));
}

/** A pool with its current members (the installed drives that are in it), ordered by serial. */
export function getPool(db: AppDb, id: string): PoolDetail {
  return db.transaction((tx) => {
    const pool = requirePool(tx, id);
    const rows = tx
      .select({
        driveId: drives.id,
        serial: drives.serial,
        capacityBytes: drives.capacityBytes,
        role: installations.poolRole,
        installedOn: installations.installedOn,
        slotId: slots.id,
        slotLabel: slots.label,
        slotPosition: slots.position,
      })
      .from(installations)
      .innerJoin(drives, eq(drives.id, installations.driveId))
      .innerJoin(slots, eq(slots.id, installations.slotId))
      .where(eq(installations.poolId, id))
      .orderBy(asc(drives.serialNormalized))
      .all();
    const members: PoolMember[] = rows.map((r) => ({
      driveId: r.driveId,
      serial: r.serial,
      capacityBytes: r.capacityBytes,
      role: r.role!,
      installedOn: r.installedOn,
      slotId: r.slotId,
      slotLabel: r.slotLabel ?? `Slot ${r.slotPosition + 1}`,
    }));
    return { ...summarize(pool, members.length), members };
  });
}

/** Deletes a pool that no installation references. Its history stays readable through the name copied on each event. */
export function deletePool(db: AppDb, id: string): void {
  db.transaction((tx) => {
    const pool = requirePool(tx, id);
    const used = tx
      .select({ driveId: installations.driveId })
      .from(installations)
      .where(eq(installations.poolId, id))
      .get();
    if (used) {
      throw conflict(`Pool ${id} still has drives installed in it and cannot be deleted`);
    }
    tx.delete(pools).where(eq(pools.id, id)).run();
    recordActivity(tx, {
      kind: 'pool-edited',
      events: [{ type: 'pool-deleted', poolId: id, poolName: pool.name, payload: { ...pool } }],
    });
  });
}
