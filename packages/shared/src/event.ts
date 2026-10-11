import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';
import { eventTypeSchema } from './enums.js';

export const eventSchema = z.object({
  id: idSchema,
  driveId: idSchema.nullable(),
  type: eventTypeSchema,
  at: timestampSchema,
  payload: z.record(z.string(), z.unknown()),
});
export type DriveEvent = z.infer<typeof eventSchema>;

/** GET /api/events/recent?limit=50 (R75): each event plus its drive's serial (null without a drive). */
export const recentEventSchema = eventSchema.extend({ driveSerial: z.string().nullable() });
export type RecentEvent = z.infer<typeof recentEventSchema>;

export const recentEventsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
