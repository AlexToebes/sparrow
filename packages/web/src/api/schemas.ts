import { z } from 'zod';
import { idSchema, poolSchema, timestampSchema, membershipRoleSchema } from '@sparrow/shared';

// Response shapes that shared does not define. They mirror the server routes; keep them in step.

/** GET /api/provider/status (R19, R56). */
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

/** GET /api/pools (core listPools). */
export const poolSummarySchema = poolSchema.extend({ memberCount: z.number().int().min(0) });
export type PoolSummary = z.infer<typeof poolSummarySchema>;

/** GET /api/pools/:id (core getPool). Members are the open memberships. */
export const poolDetailSchema = poolSummarySchema.extend({
  members: z.array(
    z.object({
      membershipId: idSchema,
      driveId: idSchema,
      serial: z.string(),
      role: membershipRoleSchema,
      startedAt: timestampSchema,
      slotLabel: z.string().nullable(),
    }),
  ),
});
export type PoolDetail = z.infer<typeof poolDetailSchema>;
