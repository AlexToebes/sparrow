import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';
import { healthSchema } from './enums.js';

// Response shape for GET /api/status (R10, R27, R28, R47). Flags are computed on every read and are
// never stored: a flagged slot still holds its drive, the user decides the outcome (R27).

export const slotFlagSchema = z.object({
  kind: z.literal('missing'),
  reason: z.enum(['decommissioned', 'stale', 'not-reported']),
});
export type SlotFlag = z.infer<typeof slotFlagSchema>;

export const slotStatusSchema = z.object({
  slotId: idSchema,
  driveId: idSchema,
  /** Last known health. Reported even when the observation is stale (never hidden). Unknown without data. */
  health: healthSchema,
  lastReportedAt: timestampSchema.nullable(),
  temperatureC: z.number().nullable(),
  detailUrl: z.url().nullable(),
  /** The observation is older than the stale threshold (R10, R18). */
  stale: z.boolean(),
  flag: slotFlagSchema.nullable(),
});
export type SlotStatus = z.infer<typeof slotStatusSchema>;

export const statusResponseSchema = z.object({
  providerId: idSchema,
  /** R47: every tracked drive (or the snapshot itself) is stale; no per-slot flags are raised. */
  providerStale: z.boolean(),
  staleAfterHours: z.number().positive(),
  lastSuccessAt: timestampSchema.nullable(),
  slots: z.array(slotStatusSchema),
});
export type StatusResponse = z.infer<typeof statusResponseSchema>;
