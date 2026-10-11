import { randomUUID } from 'node:crypto';
import { desc, eq, sql } from 'drizzle-orm';
import type { DriveEvent, EventType } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { drives, events } from '../db/schema.js';

/**
 * The transaction handle passed to `db.transaction((tx) => ...)`. `recordEvent` accepts only this
 * type, so an event cannot be written outside the change it logs (R14, AGENTS rule 6).
 */
export type DbTransaction = Parameters<Parameters<AppDb['transaction']>[0]>[0];

export interface RecordEventInput {
  driveId: string | null;
  type: EventType;
  payload: Record<string, unknown>;
  /** UTC ISO timestamp; defaults to now. */
  at?: string;
}

/** Appends one event inside the caller's transaction (R14). Call it in the same `tx` as the change. */
export function recordEvent(tx: DbTransaction, input: RecordEventInput): DriveEvent {
  return tx
    .insert(events)
    .values({
      id: randomUUID(),
      driveId: input.driveId,
      type: input.type,
      at: input.at ?? new Date().toISOString(),
      payload: input.payload,
    })
    .returning()
    .get();
}

/** A drive's events, newest first. Ties on the timestamp keep insertion order (newest first). */
export function listDriveEvents(db: AppDb, driveId: string): DriveEvent[] {
  return db
    .select()
    .from(events)
    .where(eq(events.driveId, driveId))
    .orderBy(desc(events.at), desc(sql`rowid`))
    .all();
}

/**
 * The latest events of every kind, newest first, for a future "recent changes" feed. Drive events
 * carry the drive's serial; layout and pool events (no drive) carry null.
 */
export function listRecentEvents(
  db: AppDb,
  limit: number,
): (DriveEvent & { driveSerial: string | null })[] {
  return db
    .select({
      id: events.id,
      driveId: events.driveId,
      type: events.type,
      at: events.at,
      payload: events.payload,
      driveSerial: drives.serial,
    })
    .from(events)
    .leftJoin(drives, eq(drives.id, events.driveId))
    .orderBy(desc(events.at), desc(sql`"events".rowid`))
    .limit(limit)
    .all();
}
