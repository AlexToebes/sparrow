import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';
import {
  driveLinkRoleSchema,
  driveTypeSchema,
  eventTypeSchema,
  slotLinkRoleSchema,
} from './enums.js';

// One event per real action, linked to every drive, slot and pool it involves (R14, R74).

/** A stored link to a drive. Drives are never deleted, so the id always resolves. */
export const eventDriveLinkSchema = z.object({
  driveId: idSchema,
  role: driveLinkRoleSchema,
});
export type EventDriveLink = z.infer<typeof eventDriveLinkSchema>;

/**
 * A stored link to a slot. The id has no foreign key (a deleted grid keeps its history); the label
 * and grid are copied as they were when the event was written (R39).
 */
export const eventSlotLinkSchema = z.object({
  slotId: idSchema,
  role: slotLinkRoleSchema,
  slotLabel: z.string().nullable(),
  gridId: z.string(),
  gridName: z.string(),
});
export type EventSlotLink = z.infer<typeof eventSlotLinkSchema>;

/** A stored link to a pool. The id has no foreign key (an unused pool can be deleted). */
export const eventPoolLinkSchema = z.object({
  poolId: idSchema,
  poolName: z.string(),
});
export type EventPoolLink = z.infer<typeof eventPoolLinkSchema>;

/** The links of one event as stored (and exported, R41). */
export const eventLinksSchema = z.object({
  drives: z.array(eventDriveLinkSchema),
  slots: z.array(eventSlotLinkSchema),
  pools: z.array(eventPoolLinkSchema),
});
export type EventLinks = z.infer<typeof eventLinksSchema>;

/** An event row as stored and exported: the links are nested under `links`. */
export const storedEventSchema = z.object({
  id: idSchema,
  type: eventTypeSchema,
  at: timestampSchema,
  payload: z.record(z.string(), z.unknown()),
  links: eventLinksSchema,
});
export type StoredEvent = z.infer<typeof storedEventSchema>;

/** A drive link as the API returns it: the other drive's serial and size come from the drive record. */
export const eventDriveRefSchema = eventDriveLinkSchema.extend({
  serial: z.string(),
  capacityBytes: z.number().int().nullable(),
  driveType: driveTypeSchema.nullable(),
});
export type EventDriveRef = z.infer<typeof eventDriveRefSchema>;

/**
 * An event as the API returns it (GET /api/drives/:id/events, /api/pools/:id/history,
 * /api/events/recent): the stored event with its links resolved for display.
 */
export const eventSchema = storedEventSchema.extend({
  links: z.object({
    drives: z.array(eventDriveRefSchema),
    slots: z.array(eventSlotLinkSchema),
    pools: z.array(eventPoolLinkSchema),
  }),
});
export type DriveEvent = z.infer<typeof eventSchema>;

/** GET /api/events/recent?limit=50 (R75). */
export const recentEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
