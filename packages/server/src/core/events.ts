import { randomUUID } from 'node:crypto';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { DRIVE_LINK_ROLES } from '@sparrow/shared';
import type {
  DriveEvent,
  DriveLinkRole,
  EventLinks,
  EventType,
  SlotLinkRole,
  StoredEvent,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { getGrid, getSlot } from '../db/layout-repo.js';
import { drives, eventDrives, eventPools, events, eventSlots, pools } from '../db/schema.js';

/**
 * The transaction handle passed to `db.transaction((tx) => ...)`. `recordEvent` accepts only this
 * type, so an event cannot be written outside the change it logs (R14, AGENTS rule 6).
 */
export type DbTransaction = Parameters<Parameters<AppDb['transaction']>[0]>[0];

/** Anything the readers can query with: the database itself or a transaction on it. */
type Reader = AppDb | DbTransaction;

export interface RecordEventInput {
  type: EventType;
  /** UTC ISO timestamp; defaults to now. */
  at?: string;
  payload: Record<string, unknown>;
  /** The drives this event involves; `role` defaults to `subject`. */
  drives?: { id: string; role?: DriveLinkRole }[];
  /** The slots it involves. Label and grid are copied from the slot as it is at write time. */
  slots?: { id: string; role: SlotLinkRole }[];
  /** The pools it involves. The name is copied; pass `name` for a pool that is already gone. */
  pools?: { id: string; name?: string }[];
}

/** The label a bay shows: its own, else "Slot N" (positions are zero-based). */
export const slotDisplayLabel = (slot: { label: string | null; position: number }): string =>
  slot.label ?? `Slot ${slot.position + 1}`;

/**
 * Appends one event and its drive / slot / pool links inside the caller's transaction (R14). One
 * event stands for one real action: callers link every drive, slot and pool it involves instead
 * of writing several events (R74). Call it in the same `tx` as the change, so a failure anywhere
 * leaves neither the change, the event nor any link behind.
 */
export function recordEvent(tx: DbTransaction, input: RecordEventInput): StoredEvent {
  const row = tx
    .insert(events)
    .values({
      id: randomUUID(),
      type: input.type,
      at: input.at ?? new Date().toISOString(),
      payload: input.payload,
    })
    .returning()
    .get();

  const links: EventLinks = { drives: [], slots: [], pools: [] };
  const seenDrives = new Set<string>();
  for (const d of input.drives ?? []) {
    if (seenDrives.has(d.id)) continue;
    seenDrives.add(d.id);
    links.drives.push({ driveId: d.id, role: d.role ?? 'subject' });
  }
  const seenSlots = new Set<string>();
  for (const s of input.slots ?? []) {
    const key = `${s.id}/${s.role}`;
    if (seenSlots.has(key)) continue;
    seenSlots.add(key);
    const slot = getSlot(tx, s.id);
    if (!slot) throw new Error(`recordEvent: slot ${s.id} does not exist`);
    links.slots.push({
      slotId: s.id,
      role: s.role,
      slotLabel: slotDisplayLabel(slot),
      gridId: slot.gridId,
      gridName: getGrid(tx, slot.gridId)?.name ?? '',
    });
  }
  const seenPools = new Set<string>();
  for (const p of input.pools ?? []) {
    if (seenPools.has(p.id)) continue;
    seenPools.add(p.id);
    const name = p.name ?? tx.select().from(pools).where(eq(pools.id, p.id)).get()?.name;
    if (name === undefined) throw new Error(`recordEvent: pool ${p.id} does not exist`);
    links.pools.push({ poolId: p.id, poolName: name });
  }

  if (links.drives.length > 0) {
    tx.insert(eventDrives)
      .values(links.drives.map((l) => ({ eventId: row.id, ...l })))
      .run();
  }
  if (links.slots.length > 0) {
    tx.insert(eventSlots)
      .values(links.slots.map((l) => ({ eventId: row.id, ...l })))
      .run();
  }
  if (links.pools.length > 0) {
    tx.insert(eventPools)
      .values(links.pools.map((l) => ({ eventId: row.id, ...l })))
      .run();
  }
  return { id: row.id, type: row.type, at: row.at, payload: row.payload, links };
}

type EventRow = typeof events.$inferSelect;

const CHUNK = 500;
const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

/** Stored links of the given events, by event id. */
export function loadLinks(db: Reader, eventIds: string[]): Map<string, EventLinks> {
  const out = new Map<string, EventLinks>(
    eventIds.map((id) => [id, { drives: [], slots: [], pools: [] }]),
  );
  for (const ids of chunks(eventIds)) {
    for (const r of db.select().from(eventDrives).where(inArray(eventDrives.eventId, ids)).all()) {
      out.get(r.eventId)?.drives.push({ driveId: r.driveId, role: r.role });
    }
    for (const r of db.select().from(eventSlots).where(inArray(eventSlots.eventId, ids)).all()) {
      out.get(r.eventId)?.slots.push({
        slotId: r.slotId,
        role: r.role,
        slotLabel: r.slotLabel,
        gridId: r.gridId,
        gridName: r.gridName,
      });
    }
    for (const r of db.select().from(eventPools).where(inArray(eventPools.eventId, ids)).all()) {
      out.get(r.eventId)?.pools.push({ poolId: r.poolId, poolName: r.poolName });
    }
  }
  // A stable order that reads naturally: the subject / outgoing / incoming drive, then bays from -> at -> to.
  const rank = <T extends string>(order: readonly T[], role: T) => order.indexOf(role);
  for (const l of out.values()) {
    l.drives.sort(
      (a, b) =>
        rank(DRIVE_LINK_ROLES, a.role) - rank(DRIVE_LINK_ROLES, b.role) ||
        a.driveId.localeCompare(b.driveId),
    );
    l.slots.sort(
      (a, b) =>
        rank(['from', 'at', 'to'], a.role) - rank(['from', 'at', 'to'], b.role) ||
        a.slotId.localeCompare(b.slotId),
    );
    l.pools.sort((a, b) => a.poolId.localeCompare(b.poolId));
  }
  return out;
}

/** Event rows with their links resolved for display: each linked drive's serial and size come from its record. */
export function withLinks(db: Reader, rows: EventRow[]): DriveEvent[] {
  const links = loadLinks(
    db,
    rows.map((r) => r.id),
  );
  const driveIds = [...new Set([...links.values()].flatMap((l) => l.drives.map((d) => d.driveId)))];
  const byId = new Map<string, typeof drives.$inferSelect>();
  for (const ids of chunks(driveIds)) {
    for (const d of db.select().from(drives).where(inArray(drives.id, ids)).all()) {
      byId.set(d.id, d);
    }
  }
  return rows.map((r) => {
    const l = links.get(r.id)!;
    return {
      id: r.id,
      type: r.type,
      at: r.at,
      payload: r.payload,
      links: {
        drives: l.drives.map((d) => {
          const drive = byId.get(d.driveId);
          return {
            ...d,
            serial: drive?.serial ?? d.driveId,
            capacityBytes: drive?.capacityBytes ?? null,
            driveType: drive?.driveType ?? null,
          };
        }),
        slots: l.slots,
        pools: l.pools,
      },
    };
  });
}

const newestFirst = [desc(events.at), desc(sql`"events".rowid`)] as const;

/** Events linked to a drive in any role, newest first. Ties on the timestamp keep insertion order (newest first). */
export function listDriveEvents(db: Reader, driveId: string): DriveEvent[] {
  const rows = db
    .select({ id: events.id, type: events.type, at: events.at, payload: events.payload })
    .from(events)
    .innerJoin(eventDrives, eq(eventDrives.eventId, events.id))
    .where(eq(eventDrives.driveId, driveId))
    .orderBy(...newestFirst)
    .all();
  return withLinks(db, rows);
}

/** Events linked to a pool (its record changes and its members joining, leaving, changing role), newest first. */
export function listPoolEvents(db: Reader, poolId: string): DriveEvent[] {
  const rows = db
    .select({ id: events.id, type: events.type, at: events.at, payload: events.payload })
    .from(events)
    .innerJoin(eventPools, eq(eventPools.eventId, events.id))
    .where(eq(eventPools.poolId, poolId))
    .orderBy(...newestFirst)
    .all();
  return withLinks(db, rows);
}

/** The latest events of every kind, newest first (R75), each with its drive, slot and pool links. */
export function listRecentEvents(db: Reader, limit: number): DriveEvent[] {
  const rows = db
    .select({ id: events.id, type: events.type, at: events.at, payload: events.payload })
    .from(events)
    .orderBy(...newestFirst)
    .limit(limit)
    .all();
  return withLinks(db, rows);
}
