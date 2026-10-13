import { z } from 'zod';
import { dateSchema, idSchema, timestampSchema } from './common.js';
import { activityKindSchema, driveTypeSchema, eventTypeSchema } from './enums.js';

// R14: the history is a log of ACTIVITIES (one user or system action each), each made of atomic EVENTS
// that happened together. An event is one fact about at most one drive, one slot and one pool.
// Readers group events by activity; they never pair events across activities.

/**
 * One atomic event as stored and exported (R41). The drive link has a foreign key (drives are never
 * deleted); the slot and pool links have none, so history survives a deleted grid or pool, and the
 * bay's label and grid and the pool's name are copied as they were when the event was written (R39).
 */
export const storedEventSchema = z.object({
  id: idSchema,
  /** Position within the activity. */
  ord: z.number().int().min(0),
  type: eventTypeSchema,
  driveId: idSchema.nullable(),
  slotId: idSchema.nullable(),
  slotLabel: z.string().nullable(),
  gridId: z.string().nullable(),
  gridName: z.string().nullable(),
  poolId: idSchema.nullable(),
  poolName: z.string().nullable(),
  payload: z.record(z.string(), z.unknown()),
});
export type StoredEvent = z.infer<typeof storedEventSchema>;

/** An activity row as stored and exported, with its events nested in order. */
export const storedActivitySchema = z.object({
  id: idSchema,
  /** Monotonic position in the log; every ordering uses it, never the timestamps. */
  seq: z.number().int().min(1),
  kind: activityKindSchema,
  /** When the action was recorded (UTC). */
  recordedAt: timestampSchema,
  /** The user's date for the action (installation, removal, retirement date); null = not recorded / not applicable. */
  occurredOn: dateSchema.nullable(),
  note: z.string().nullable(),
  events: z.array(storedEventSchema),
});
export type StoredActivity = z.infer<typeof storedActivitySchema>;

/** The drive an event is about, as the API resolves it from the drive record (not copied into the log). */
export const eventDriveSchema = z.object({
  serial: z.string(),
  capacityBytes: z.number().int().nullable(),
  driveType: driveTypeSchema.nullable(),
});
export type EventDrive = z.infer<typeof eventDriveSchema>;

/** An event as the API returns it: the stored event plus its drive's serial and size. */
export const eventSchema = storedEventSchema.extend({ drive: eventDriveSchema.nullable() });
export type ActivityEvent = z.infer<typeof eventSchema>;

/**
 * An activity as the API returns it (GET /api/drives/:id/history, /api/pools/:id/history,
 * /api/activities/recent), always WITH ALL its events, in order.
 */
export const activitySchema = storedActivitySchema.extend({ events: z.array(eventSchema) });
export type Activity = z.infer<typeof activitySchema>;

/** GET /api/activities/recent?limit=50&before=SEQ (R75). `before` is an exclusive seq cursor for paging. */
export const recentActivitiesQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  before: z.coerce.number().int().min(1).optional(),
});
