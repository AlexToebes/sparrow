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

/** GET /api/provider/status (R19, R56). `capabilities` is the provider's own flags, shown as-is. */
export const providerStatusSchema = z.object({
  providerId: idSchema,
  capabilities: z.record(z.string(), z.unknown()).optional(),
  reachable: z.boolean(),
  lastSuccessAt: timestampSchema.nullable(),
  lastAttemptAt: timestampSchema.nullable(),
  lastError: z.string().nullable(),
  observationCount: z.number().int().min(0),
});
export type ProviderStatus = z.infer<typeof providerStatusSchema>;
