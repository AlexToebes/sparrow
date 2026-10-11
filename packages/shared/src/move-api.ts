import { z } from 'zod';
import { dateSchema, idSchema } from './common.js';
import { membershipRoleSchema, retirementReasonSchema } from './enums.js';
import { occupantResolutionSchema } from './assignment-api.js';

// Request body for moving an installed drive (R73): to the spares, another bay, retirement or RMA,
// optionally with a spare taking its place, as one step with one optional date.

const note = z.string().trim().min(1).max(5000).nullish();

/**
 * What happens to the drive in the target bay: any plain occupant resolution (R37), or `swap` (R73),
 * which puts that drive into the bay the moving drive leaves. Only Move accepts `swap`.
 */
export const moveOccupantSchema = z.discriminatedUnion('action', [
  ...occupantResolutionSchema.options,
  z.strictObject({ action: z.literal('swap') }),
]);
export type MoveOccupant = z.infer<typeof moveOccupantSchema>;

/** Where the moving drive goes. `retire` takes a reason (R60), no default. */
export const moveDestinationSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('spares') }),
  /** Another bay. If it is occupied, `occupant` says what happens to that drive (R37), else 409. */
  z.strictObject({
    kind: z.literal('slot'),
    slotId: idSchema,
    occupant: moveOccupantSchema.optional(),
  }),
  z.strictObject({ kind: z.literal('retire'), reason: retirementReasonSchema, note }),
  z.strictObject({ kind: z.literal('rma'), note }),
]);
export type MoveDestination = z.infer<typeof moveDestinationSchema>;

/** A spare that takes the bay the drive leaves (R8, R35). `poolId` omitted = default from this drive. */
export const moveReplacementSchema = z.strictObject({
  driveId: idSchema,
  poolId: idSchema.nullish(),
  role: membershipRoleSchema.optional(),
});
export type MoveReplacement = z.infer<typeof moveReplacementSchema>;

/**
 * POST /api/drives/:id/move. `date` is the one date of the move: omitted = today (UTC); null = not
 * recorded for any step; future dates are rejected. It is the removal, retirement or RMA date of
 * this drive, its installation date in the new bay, and the installation date of the incoming spare.
 */
export const moveDriveInputSchema = z.strictObject({
  destination: moveDestinationSchema,
  replacement: moveReplacementSchema.optional(),
  date: dateSchema.nullable().optional(),
});
export type MoveDriveInput = z.infer<typeof moveDriveInputSchema>;
