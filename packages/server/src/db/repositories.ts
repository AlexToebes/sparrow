import { randomUUID } from 'node:crypto';
import { asc, eq } from 'drizzle-orm';
import type { AppDatabase } from './client.js';
import { normalizeSerial } from '@sparrow/shared';
import { drives, enclosures, events, grids, memberships, pools, slots } from './schema.js';

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

export function createRepositories(db: AppDatabase) {
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
