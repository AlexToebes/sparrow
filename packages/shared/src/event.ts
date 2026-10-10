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
