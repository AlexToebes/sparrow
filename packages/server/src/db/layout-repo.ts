import { asc, eq, inArray, sql } from 'drizzle-orm';
import type { AppDb } from './client.js';
import { appMeta, enclosures, grids, installations, slots } from './schema.js';

// Layout persistence. Used inside service transactions (core/layout.ts), so every
// function takes the transaction handle. Business rules live in the service.

export type Tx = Parameters<Parameters<AppDb['transaction']>[0]>[0];
export type EnclosureRow = typeof enclosures.$inferSelect;
export type GridRow = typeof grids.$inferSelect;
export type SlotRow = typeof slots.$inferSelect;

// rowid keeps insertion order, so seeded enclosures and grids list in seed order.
const insertionOrder = sql`rowid`;

export const selectEnclosures = (tx: Tx): EnclosureRow[] =>
  tx.select().from(enclosures).orderBy(asc(insertionOrder)).all();

export const getEnclosure = (tx: Tx, id: string): EnclosureRow | undefined =>
  tx.select().from(enclosures).where(eq(enclosures.id, id)).get();

export const insertEnclosure = (tx: Tx, row: EnclosureRow): void => {
  tx.insert(enclosures).values(row).run();
};

export const updateEnclosure = (tx: Tx, row: EnclosureRow): void => {
  tx.update(enclosures)
    .set({ name: row.name, updatedAt: row.updatedAt })
    .where(eq(enclosures.id, row.id))
    .run();
};

export const deleteEnclosure = (tx: Tx, id: string): void => {
  tx.delete(enclosures).where(eq(enclosures.id, id)).run();
};

/** All grids, or only those of one enclosure. */
export const selectGrids = (tx: Tx, enclosureId?: string): GridRow[] =>
  tx
    .select()
    .from(grids)
    .where(enclosureId === undefined ? undefined : eq(grids.enclosureId, enclosureId))
    .orderBy(asc(insertionOrder))
    .all();

export const getGrid = (tx: Tx, id: string): GridRow | undefined =>
  tx.select().from(grids).where(eq(grids.id, id)).get();

export const insertGrid = (tx: Tx, row: GridRow): void => {
  tx.insert(grids).values(row).run();
};

export const updateGrid = (tx: Tx, row: GridRow): void => {
  tx.update(grids)
    .set({
      name: row.name,
      rows: row.rows,
      columns: row.columns,
      orientation: row.orientation,
      updatedAt: row.updatedAt,
    })
    .where(eq(grids.id, row.id))
    .run();
};

export const deleteGrid = (tx: Tx, id: string): void => {
  tx.delete(grids).where(eq(grids.id, id)).run();
};

/** Slots of the given grids (all slots when omitted), ordered by position. */
export const selectSlots = (tx: Tx, gridIds?: string[]): SlotRow[] => {
  if (gridIds !== undefined && gridIds.length === 0) return [];
  return tx
    .select()
    .from(slots)
    .where(gridIds === undefined ? undefined : inArray(slots.gridId, gridIds))
    .orderBy(asc(slots.gridId), asc(slots.position))
    .all();
};

export const getSlot = (tx: Tx, id: string): SlotRow | undefined =>
  tx.select().from(slots).where(eq(slots.id, id)).get();

export const insertSlots = (tx: Tx, rows: SlotRow[]): void => {
  if (rows.length > 0) tx.insert(slots).values(rows).run();
};

export const updateSlotLabel = (tx: Tx, id: string, label: string | null, at: string): void => {
  tx.update(slots).set({ label, updatedAt: at }).where(eq(slots.id, id)).run();
};

export const deleteSlots = (tx: Tx, ids: string[]): void => {
  if (ids.length > 0) tx.delete(slots).where(inArray(slots.id, ids)).run();
};

/** Occupied slots (an installation exists) among the given slot IDs, or among all slots when omitted. */
export const occupants = (tx: Tx, slotIds?: string[]): { slotId: string; driveId: string }[] => {
  if (slotIds !== undefined && slotIds.length === 0) return [];
  return tx
    .select({ slotId: installations.slotId, driveId: installations.driveId })
    .from(installations)
    .where(slotIds === undefined ? undefined : inArray(installations.slotId, slotIds))
    .all();
};

export const getMeta = (tx: Tx, key: string): string | null =>
  tx.select().from(appMeta).where(eq(appMeta.key, key)).get()?.value ?? null;

export const setMeta = (tx: Tx, key: string, value: string): void => {
  tx.insert(appMeta)
    .values({ key, value })
    .onConflictDoUpdate({ target: appMeta.key, set: { value } })
    .run();
};
