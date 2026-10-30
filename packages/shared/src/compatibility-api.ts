import { z } from 'zod';
import { idSchema } from './common.js';
import { spareConflictSchema } from './conflict.js';
import { driveTypeSchema } from './enums.js';

// GET /api/slots/:id/compatibility (R12): advice on which spares fit a bay. Computed on every read,
// never stored, and never blocks an action.

export const compatibilityVerdictSchema = z.enum([
  'fits',
  'too-small',
  'different-type',
  'unknown',
]);
export type CompatibilityVerdict = z.infer<typeof compatibilityVerdictSchema>;

export const spareCompatibilitySchema = z.object({
  driveId: idSchema,
  verdict: compatibilityVerdictSchema,
  /** A short sentence for the reason (shown as the badge's detail). */
  reason: z.string(),
  /** Set for `too-small`: the smallest capacity that would fit. */
  neededBytes: z.number().nullable(),
  /**
   * R78: current members of the target pool (not the drive being replaced) this spare is not
   * recommended with. Advice beside the verdict; it never changes the verdict.
   */
  conflicts: z.array(spareConflictSchema).default([]),
});
export type SpareCompatibility = z.infer<typeof spareCompatibilitySchema>;

/** What a spare is compared against; null when the bay has no occupant now and none before. */
export const compatibilityTargetSchema = z.object({
  driveType: driveTypeSchema.nullable(),
  /** The per-disk size a spare must reach, or null when unknown. */
  sizeBytes: z.number().nullable(),
  /** `pool`: the smallest current member of the pool; `drive`: the occupant's own capacity. */
  basis: z.enum(['pool', 'drive']),
  poolName: z.string().nullable(),
  /** Serial of the drive in the bay now, or else the one that was there last. */
  serial: z.string(),
});
export type CompatibilityTarget = z.infer<typeof compatibilityTargetSchema>;

export const slotCompatibilitySchema = z.object({
  slotId: idSchema,
  target: compatibilityTargetSchema.nullable(),
  /** One verdict per spare on the shelf; empty when there is no target. */
  spares: z.array(spareCompatibilitySchema),
});
export type SlotCompatibility = z.infer<typeof slotCompatibilitySchema>;
