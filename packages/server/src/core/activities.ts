import { randomUUID } from 'node:crypto';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import type { Activity, ActivityKind, EventType, StoredActivity } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { getGrid, getSlot } from '../db/layout-repo.js';
import { activities, drives, events, pools } from '../db/schema.js';

/**
 * The transaction handle passed to `db.transaction((tx) => ...)`. `recordActivity` accepts only this
 * type, so history cannot be written outside the change it logs (R14, AGENTS rule 6).
 */
export type DbTransaction = Parameters<Parameters<AppDb['transaction']>[0]>[0];

/** Anything the readers can query with: the database itself or a transaction on it. */
export type Reader = AppDb | DbTransaction;

/**
 * One atomic fact: it concerns at most one drive, one slot and one pool (R14). The payload carries
 * enough to apply AND undo it (full before/after of what changed, the whole record for created and
 * deleted things), so any past state can be rebuilt from the log (core/replay.ts).
 */
export interface EventInput {
  type: EventType;
  driveId?: string | null;
  slotId?: string | null;
  poolId?: string | null;
  /** The bay's snapshot for a bay that is gone by the time the activity is recorded. */
  slotSnapshot?: { label: string | null; gridId: string; gridName: string };
  /** The pool's name for a pool that is gone by the time the activity is recorded. */
  poolName?: string;
  payload: Record<string, unknown>;
}

export interface ActivityInput {
  kind: ActivityKind;
  /** The user's date for the action (YYYY-MM-DD); omitted or null = not recorded / not applicable. */
  occurredOn?: string | null | undefined;
  note?: string | null | undefined;
  /** UTC ISO timestamp the action is recorded at; defaults to now. */
  recordedAt?: string;
  events: EventInput[];
}

/** The label a bay shows: its own, else "Slot N" (positions are zero-based). */
export const slotDisplayLabel = (slot: { label: string | null; position: number }): string =>
  slot.label ?? `Slot ${slot.position + 1}`;

/**
 * THE way to write history (R14, AGENTS rule 6): inserts one activity and its events, in order, inside
 * the caller's transaction, so a failure anywhere leaves neither the change nor any of its log behind.
 * It assigns the monotonic `seq` and fills the bay and pool snapshots from the rows as they are now.
 * One real action is one activity: composite helpers return event descriptors and the top-level action
 * records them once.
 */
export function recordActivity(tx: DbTransaction, input: ActivityInput): StoredActivity {
  if (input.events.length === 0) throw new Error('recordActivity: an activity needs an event');
  const next =
    tx
      .select({ max: sql<number | null>`max(${activities.seq})` })
      .from(activities)
      .get()?.max ?? 0;
  const row = tx
    .insert(activities)
    .values({
      id: randomUUID(),
      seq: next + 1,
      kind: input.kind,
      recordedAt: input.recordedAt ?? new Date().toISOString(),
      occurredOn: input.occurredOn ?? null,
      note: input.note ?? null,
    })
    .returning()
    .get();

  const stored = input.events.map((e, ord) => {
    let slotLabel: string | null = null;
    let gridId: string | null = null;
    let gridName: string | null = null;
    if (e.slotId) {
      const slot = getSlot(tx, e.slotId);
      if (slot) {
        slotLabel = slotDisplayLabel(slot);
        gridId = slot.gridId;
        gridName = getGrid(tx, slot.gridId)?.name ?? '';
      } else if (e.slotSnapshot) {
        slotLabel = e.slotSnapshot.label;
        gridId = e.slotSnapshot.gridId;
        gridName = e.slotSnapshot.gridName;
      } else {
        throw new Error(`recordActivity: slot ${e.slotId} does not exist`);
      }
    }
    let poolName: string | null = null;
    if (e.poolId) {
      poolName =
        tx.select().from(pools).where(eq(pools.id, e.poolId)).get()?.name ?? e.poolName ?? null;
      if (poolName === null) throw new Error(`recordActivity: pool ${e.poolId} does not exist`);
    }
    return tx
      .insert(events)
      .values({
        id: randomUUID(),
        activityId: row.id,
        ord,
        type: e.type,
        driveId: e.driveId ?? null,
        slotId: e.slotId ?? null,
        slotLabel,
        gridId,
        gridName,
        poolId: e.poolId ?? null,
        poolName,
        payload: e.payload,
      })
      .returning()
      .get();
  });
  return {
    id: row.id,
    seq: row.seq,
    kind: row.kind,
    recordedAt: row.recordedAt,
    occurredOn: row.occurredOn,
    note: row.note,
    events: stored.map(nested),
  };
}

type ActivityRow = typeof activities.$inferSelect;

/** An event row without its key to the activity (the activity nests it). */
function nested(row: typeof events.$inferSelect) {
  const { activityId, ...rest } = row;
  void activityId;
  return rest;
}

const CHUNK = 500;
const chunks = <T>(items: T[]): T[][] => {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += CHUNK) out.push(items.slice(i, i + CHUNK));
  return out;
};

/** The given activities with ALL their events in order, each event with its drive's serial and size. Newest first. */
export function withEvents(db: Reader, rows: ActivityRow[]): Activity[] {
  const ordered = [...rows].sort((a, b) => b.seq - a.seq);
  const byActivity = new Map<string, (typeof events.$inferSelect)[]>();
  for (const ids of chunks(ordered.map((r) => r.id))) {
    for (const e of db.select().from(events).where(inArray(events.activityId, ids)).all()) {
      const list = byActivity.get(e.activityId) ?? [];
      list.push(e);
      byActivity.set(e.activityId, list);
    }
  }
  const driveIds = [
    ...new Set(
      [...byActivity.values()].flatMap((l) => l.flatMap((e) => (e.driveId ? [e.driveId] : []))),
    ),
  ];
  const driveById = new Map<string, typeof drives.$inferSelect>();
  for (const ids of chunks(driveIds)) {
    for (const d of db.select().from(drives).where(inArray(drives.id, ids)).all()) {
      driveById.set(d.id, d);
    }
  }
  return ordered.map((a) => ({
    id: a.id,
    seq: a.seq,
    kind: a.kind,
    recordedAt: a.recordedAt,
    occurredOn: a.occurredOn,
    note: a.note,
    events: (byActivity.get(a.id) ?? [])
      .sort((x, y) => x.ord - y.ord)
      .map(nested)
      .map((e) => {
        const d = e.driveId ? driveById.get(e.driveId) : undefined;
        return {
          ...e,
          drive: d
            ? { serial: d.serial, capacityBytes: d.capacityBytes, driveType: d.driveType }
            : e.driveId
              ? { serial: e.driveId, capacityBytes: null, driveType: null }
              : null,
        };
      }),
  }));
}

const activitiesWhere = (db: Reader, column: 'driveId' | 'poolId', id: string): Activity[] => {
  const ids = db
    .selectDistinct({ id: events.activityId })
    .from(events)
    .where(eq(events[column], id))
    .all()
    .map((r) => r.id);
  const rows: ActivityRow[] = [];
  for (const chunk of chunks(ids)) {
    rows.push(...db.select().from(activities).where(inArray(activities.id, chunk)).all());
  }
  return withEvents(db, rows);
};

/** Activities with at least one event for the drive, each with all its events, newest first by seq (R14). */
export const listDriveActivities = (db: Reader, driveId: string): Activity[] =>
  activitiesWhere(db, 'driveId', driveId);

/** Activities with an event on the pool (its record, its members joining, leaving, changing role), newest first. */
export const listPoolActivities = (db: Reader, poolId: string): Activity[] =>
  activitiesWhere(db, 'poolId', poolId);

/** The latest activities of every kind, newest first (R75). */
export function listRecentActivities(db: Reader, limit: number): Activity[] {
  return withEvents(
    db,
    db.select().from(activities).orderBy(desc(activities.seq)).limit(limit).all(),
  );
}

/** A drive's events of one type, newest first by log position (seq, then order within the activity). */
export function listDriveEventsOfType(
  db: Reader,
  driveId: string,
  type: EventType,
): { payload: Record<string, unknown> }[] {
  return db
    .select({ payload: events.payload })
    .from(events)
    .innerJoin(activities, eq(activities.id, events.activityId))
    .where(sql`${events.driveId} = ${driveId} AND ${events.type} = ${type}`)
    .orderBy(desc(activities.seq), desc(events.ord))
    .all();
}
