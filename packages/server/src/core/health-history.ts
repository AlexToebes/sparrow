import { and, desc, eq, sql } from 'drizzle-orm';
import type { Health, Observation } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { eventDrives, events } from '../db/schema.js';
import { listDrives } from './drives.js';
import { recordEvent, type DbTransaction } from './events.js';
import { matchObservations } from './matching.js';

// R20: health changes written to the drive's event log. Runs after each successful poll. It only
// appends events: it never changes a drive's status or anything else (R10, flag never auto-change).

/** Payload of a `health-changed` event. `from` is null for the first report. */
export interface HealthChangedPayload {
  from: Health | null;
  to: Health;
  /** When the provider last reported this health (the observation's `lastReportedAt`). */
  reportedAt: string;
}

/** The `to` of the drive's latest health-changed event, or undefined when it has none. */
function lastRecordedHealth(tx: DbTransaction, driveId: string): Health | undefined {
  const row = tx
    .select({ payload: events.payload })
    .from(events)
    .innerJoin(eventDrives, eq(eventDrives.eventId, events.id))
    .where(and(eq(eventDrives.driveId, driveId), eq(events.type, 'health-changed')))
    .orderBy(desc(events.at), desc(sql`"events".rowid`))
    .limit(1)
    .get();
  const to = row?.payload.to;
  return typeof to === 'string' ? (to as Health) : undefined;
}

/**
 * Compares each matched observation's health with the drive's last recorded health and logs the
 * difference, all in one transaction. `at` is the poll time. Decommissioned observations carry a
 * last-known health, not a report, so they are skipped (R63 handles them). Returns the number of
 * events written. The caller must only pass observations of the active provider (R55).
 */
export function recordHealthChanges(
  db: AppDb,
  observations: readonly Observation[],
  at: string,
): number {
  const { matchedByDriveId } = matchObservations(listDrives(db), observations);
  return db.transaction((tx) => {
    let written = 0;
    for (const { drive, observation } of matchedByDriveId.values()) {
      if (observation.state === 'decommissioned') continue;
      const previous = lastRecordedHealth(tx, drive.id);
      if (previous === observation.health) continue;
      const payload: HealthChangedPayload = {
        from: previous ?? null,
        to: observation.health,
        reportedAt: observation.lastReportedAt,
      };
      recordEvent(tx, {
        type: 'health-changed',
        at,
        drives: [{ id: drive.id }],
        payload: { ...payload },
      });
      written++;
    }
    return written;
  });
}
