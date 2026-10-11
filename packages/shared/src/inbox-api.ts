import { z } from 'zod';
import { dateSchema, idSchema } from './common.js';
import { driveSchema } from './drive.js';
import {
  driveConditionSchema,
  healthSchema,
  driveTypeSchema,
  retirementReasonSchema,
} from './enums.js';
import { installedOnSchema, occupantResolutionSchema } from './assignment-api.js';
import { membershipRoleSchema } from './enums.js';
import { observationSchema } from './observation.js';

// Request and response shapes for the discovery inbox (R9, R22 to R25, R58, R63).
// Resolving an entry also picks the slot (decision under R23), so these reuse the assignment fields.

const note = z.string().trim().min(1).nullish();

const placement = {
  slotId: idSchema,
  /** Omitted = default from the slot's previous occupant; null = no pool (R35). */
  poolId: idSchema.nullish(),
  role: membershipRoleSchema.optional(),
  occupant: occupantResolutionSchema.optional(),
  /** R68: omitted or null = installation date not recorded (the drive is already in the NAS). */
  installedOn: installedOnSchema.optional(),
};

/** POST /api/inbox/:key/link. Links the observation to an existing spare and installs it. */
export const linkObservationInputSchema = z.strictObject({ driveId: idSchema, ...placement });
export type LinkObservationInput = z.infer<typeof linkObservationInputSchema>;

/** POST /api/inbox/:key/create. R11 fields the observation cannot supply may be given too. */
export const createFromObservationInputSchema = z.strictObject({
  ...placement,
  condition: driveConditionSchema.nullish(),
  purchaseDate: driveSchema.shape.purchaseDate.optional(),
  warrantyExpiry: driveSchema.shape.warrantyExpiry.optional(),
  vendor: z.string().trim().min(1).nullish(),
  notes: z.string().trim().min(1).nullish(),
});
export type CreateFromObservationInput = z.infer<typeof createFromObservationInputSchema>;

/**
 * POST /api/inbox/import-retired. A reason is required for every item: there is no default (R63).
 * `date` omitted = the observation's last-reported day (the prefill); null = not recorded (R60).
 */
export const importRetiredInputSchema = z.strictObject({
  items: z
    .array(
      z.strictObject({
        observationKey: z.string().min(1),
        reason: retirementReasonSchema,
        date: dateSchema.nullable().optional(),
        note,
      }),
    )
    .min(1),
});
export type ImportRetiredInput = z.infer<typeof importRetiredInputSchema>;

export const inboxEntrySchema = z.object({
  observationKey: z.string().min(1),
  observation: observationSchema,
  /** A spare that matches the observation; nothing is applied until confirmed (R25). */
  suggestion: driveSchema.nullable(),
});
export type InboxEntry = z.infer<typeof inboxEntrySchema>;

export const retiredCandidateSchema = z.object({
  observationKey: z.string().min(1),
  serial: z.string().min(1),
  model: z.string().nullable(),
  capacityBytes: z.number().int().nullable(),
  driveType: driveTypeSchema.nullable(),
  /** YYYY-MM-DD from lastReportedAt; approximate and editable (R63). */
  retirementDate: dateSchema,
  /** Last known health. A hint only, never applied (R63). */
  healthHint: healthSchema,
});
export type RetiredCandidate = z.infer<typeof retiredCandidateSchema>;

/** GET /api/inbox. */
export const inboxResponseSchema = z.object({
  entries: z.array(inboxEntrySchema),
  unidentified: z.array(observationSchema),
  retiredCandidates: z.array(retiredCandidateSchema),
  count: z.number().int().min(0),
});
export type InboxResponse = z.infer<typeof inboxResponseSchema>;
