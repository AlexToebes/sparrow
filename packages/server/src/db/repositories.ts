import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { AppDb } from './client.js';
import { normalizeSerial, observationSchema, type Observation } from '@sparrow/shared';
import { z } from 'zod';
import {
  appMeta,
  drives,
  enclosures,
  events,
  grids,
  memberships,
  pools,
  providerSnapshot,
  slots,
} from './schema.js';

// Minimal persistence only. Business rules live in services (Step 2+); the DB enforces integrity.
// Drives deliberately have no delete function (D5).

const now = (): string => new Date().toISOString();

type Omitted = 'id' | 'createdAt' | 'updatedAt';

export type NewEnclosure = Omit<typeof enclosures.$inferInsert, Omitted>;
export type NewGrid = Omit<typeof grids.$inferInsert, Omitted>;
export type NewSlot = Omit<typeof slots.$inferInsert, Omitted>;
export type NewDrive = Omit<typeof drives.$inferInsert, Omitted | 'serialNormalized'>;
export type NewPool = Omit<typeof pools.$inferInsert, Omitted>;
export type NewMembership = Omit<typeof memberships.$inferInsert, 'id' | 'createdAt'>;
export type NewEvent = Omit<typeof events.$inferInsert, 'id' | 'at'> & { at?: string };

export interface NewSnapshot {
  providerId: string;
  observations: Observation[];
  lastSuccessAt?: string | null;
  lastAttemptAt?: string | null;
  lastError?: string | null;
}

export interface SnapshotRow {
  providerId: string;
  observations: Observation[];
  lastSuccessAt: string | null;
  lastAttemptAt: string | null;
  lastError: string | null;
}

const observationsSchema = z.array(observationSchema);

export function createRepositories(db: AppDb) {
  const stamp = () => {
    const t = now();
    return { id: randomUUID(), createdAt: t, updatedAt: t };
  };

  return {
    enclosures: {
      create(input: NewEnclosure) {
        return db
          .insert(enclosures)
          .values({ ...input, ...stamp() })
          .returning()
          .get();
      },
      get: (id: string) => db.select().from(enclosures).where(eq(enclosures.id, id)).get(),
      list: () => db.select().from(enclosures).orderBy(asc(enclosures.name)).all(),
    },
    grids: {
      create(input: NewGrid) {
        return db
          .insert(grids)
          .values({ ...input, ...stamp() })
          .returning()
          .get();
      },
      get: (id: string) => db.select().from(grids).where(eq(grids.id, id)).get(),
      list: () => db.select().from(grids).orderBy(asc(grids.name)).all(),
    },
    slots: {
      create(input: NewSlot) {
        return db
          .insert(slots)
          .values({ ...input, ...stamp() })
          .returning()
          .get();
      },
      get: (id: string) => db.select().from(slots).where(eq(slots.id, id)).get(),
      listByGrid: (gridId: string) =>
        db.select().from(slots).where(eq(slots.gridId, gridId)).orderBy(asc(slots.position)).all(),
    },
    drives: {
      create(input: NewDrive) {
        const serial = input.serial.trim();
        return db
          .insert(drives)
          .values({ ...input, serial, serialNormalized: normalizeSerial(serial), ...stamp() })
          .returning()
          .get();
      },
      get: (id: string) => db.select().from(drives).where(eq(drives.id, id)).get(),
      list: () => db.select().from(drives).orderBy(asc(drives.serialNormalized)).all(),
    },
    pools: {
      create(input: NewPool) {
        return db
          .insert(pools)
          .values({ ...input, ...stamp() })
          .returning()
          .get();
      },
      get: (id: string) => db.select().from(pools).where(eq(pools.id, id)).get(),
      list: () => db.select().from(pools).orderBy(asc(pools.name)).all(),
    },
    memberships: {
      create(input: NewMembership) {
        return db
          .insert(memberships)
          .values({ ...input, id: randomUUID(), createdAt: now() })
          .returning()
          .get();
      },
      get: (id: string) => db.select().from(memberships).where(eq(memberships.id, id)).get(),
      listByDrive: (driveId: string) =>
        db
          .select()
          .from(memberships)
          .where(eq(memberships.driveId, driveId))
          .orderBy(asc(memberships.startedAt))
          .all(),
    },
    meta: {
      get(key: string): string | null {
        const row = db.select().from(appMeta).where(eq(appMeta.key, key)).get();
        return row?.value ?? null;
      },
      set(key: string, value: string): void {
        db.insert(appMeta)
          .values({ key, value })
          .onConflictDoUpdate({ target: appMeta.key, set: { value } })
          .run();
      },
    },
    // Single-row cache (R18, R55). Observations are validated on the way in and out.
    snapshot: {
      get(): SnapshotRow | null {
        const row = db.select().from(providerSnapshot).where(eq(providerSnapshot.id, 1)).get();
        if (!row) return null;
        return {
          providerId: row.providerId,
          observations: observationsSchema.parse(row.observations),
          lastSuccessAt: row.lastSuccessAt,
          lastAttemptAt: row.lastAttemptAt,
          lastError: row.lastError,
        };
      },
      put(input: NewSnapshot): void {
        const values = {
          providerId: input.providerId,
          observations: observationsSchema.parse(input.observations),
          lastSuccessAt: input.lastSuccessAt ?? null,
          lastAttemptAt: input.lastAttemptAt ?? null,
          lastError: input.lastError ?? null,
        };
        db.insert(providerSnapshot)
          .values({ id: 1, ...values })
          .onConflictDoUpdate({ target: providerSnapshot.id, set: values })
          .run();
      },
      clear(): void {
        db.delete(providerSnapshot).where(eq(providerSnapshot.id, 1)).run();
      },
    },
    events: {
      create(input: NewEvent) {
        return db
          .insert(events)
          .values({ ...input, id: randomUUID(), at: input.at ?? now() })
          .returning()
          .get();
      },
      get: (id: string) => db.select().from(events).where(eq(events.id, id)).get(),
      listByDrive: (driveId: string) =>
        db.select().from(events).where(eq(events.driveId, driveId)).orderBy(asc(events.at)).all(),
    },
  };
}

export type Repositories = ReturnType<typeof createRepositories>;
