import type { Activity, ActivityEvent, EventType } from '@sparrow/shared';
import { listDriveActivities, listRecentActivities } from '../src/core/activities.js';
import type { AppDb } from '../src/db/client.js';

// Compact views of the activity log for assertions.

/** Every activity, oldest first (by seq). */
export const activitiesOf = (db: AppDb): Activity[] => listRecentActivities(db, 200).reverse();

/** The newest activity. */
export function lastActivity(db: AppDb): Activity {
  const a = listRecentActivities(db, 1)[0];
  if (!a) throw new Error('no activity recorded');
  return a;
}

export const countActivities = (db: AppDb): number => listRecentActivities(db, 200).length;

/** The events of an activity with the given type. */
export const ofType = (a: Activity, type: EventType): ActivityEvent[] =>
  a.events.filter((e) => e.type === type);

/** The event types of an activity, in order. */
export const shape = (a: Activity): EventType[] => a.events.map((e) => e.type);

/** The activity kinds of the whole log, oldest first. */
export const kindsOf = (db: AppDb): string[] => activitiesOf(db).map((a) => a.kind);

/** `driveId -> [type, ...]` view of an activity, for asserting who did what. */
export const byDrive = (a: Activity): [string | null, EventType][] =>
  a.events.map((e) => [e.driveId, e.type]);

/** The events about one drive, newest first (by activity seq, then position in the activity). */
export const eventsOfDrive = (db: AppDb, driveId: string): ActivityEvent[] =>
  listDriveActivities(db, driveId).flatMap((a) =>
    a.events.filter((e) => e.driveId === driveId).reverse(),
  );
