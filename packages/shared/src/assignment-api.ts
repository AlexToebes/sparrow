import { z } from 'zod';
import { dateSchema, idSchema } from './common.js';
import { membershipRoleSchema, retirementReasonSchema } from './enums.js';

// Request bodies for slot assignment and drive retirement (R8, R35, R37, R60, R61, R62).

const note = z.string().trim().min(1).max(5000).nullish();

/**
 * R68: the day the drive went into the slot, or null for "installation date not recorded". The
 * server rejects future dates. Omitting the field is deliberately NOT the same as null, and the
 * default depends on the flow:
 *  - POST /api/slots/:id/assign (moving a spare in now): omitted = today (UTC); null = not recorded.
 *  - POST /api/inbox/:key/link and /create (a drive already found in the NAS): omitted or null =
 *    not recorded, because the real installation date is unknown unless the user says so.
 */
export const installedOnSchema = dateSchema.nullable();

/**
 * R69: the day the drive physically left its slot, or null for "removal date not recorded". The
 * server rejects future dates and dates before the installation or pool start. Omitted = today (UTC).
 */
export const removedOnSchema = dateSchema.nullable();

/**
 * R60: the day a drive was retired (or sent for RMA), or null for "retirement date not recorded".
 * The server rejects future dates. Omitted = today (UTC); null = not recorded.
 */
export const retirementDateSchema = dateSchema.nullable();

/** How to deal with the drive already in the slot (R37). */
export const occupantResolutionSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('spare'), removedOn: removedOnSchema.optional() }),
  z.strictObject({
    action: z.literal('retire'),
    reason: retirementReasonSchema,
    date: retirementDateSchema.optional(),
    note,
  }),
  z.strictObject({ action: z.literal('rma'), date: retirementDateSchema.optional(), note }),
]);
export type OccupantResolution = z.infer<typeof occupantResolutionSchema>;

/** POST /api/slots/:id/assign. `poolId` omitted = default from the previous occupant; null = no pool (R35). */
export const assignDriveInputSchema = z.strictObject({
  driveId: idSchema,
  poolId: idSchema.nullish(),
  role: membershipRoleSchema.optional(),
  occupant: occupantResolutionSchema.optional(),
  installedOn: installedOnSchema.optional(),
});
export type AssignDriveInput = z.infer<typeof assignDriveInputSchema>;

/** POST /api/drives/:id/reinstate. */
export const noteInputSchema = z.strictObject({ note });
export type NoteInput = z.infer<typeof noteInputSchema>;

/** POST /api/drives/:id/remove (R69). `removedOn` omitted = today (UTC); null = not recorded. */
export const removeDriveInputSchema = z.strictObject({
  note,
  removedOn: removedOnSchema.optional(),
});
export type RemoveDriveInput = z.infer<typeof removeDriveInputSchema>;

/** POST /api/drives/:id/retire. `date` omitted = today (UTC); null = not recorded (R60). */
export const retireDriveInputSchema = z.strictObject({
  reason: retirementReasonSchema,
  date: retirementDateSchema.optional(),
  note,
});
export type RetireDriveInput = z.infer<typeof retireDriveInputSchema>;

/** POST /api/drives/:id/rma. */
export const rmaInputSchema = z.strictObject({ date: retirementDateSchema.optional(), note });
export type RmaInput = z.infer<typeof rmaInputSchema>;

/** GET /api/slots/:id/assignment-defaults. */
export const assignmentDefaultsSchema = z.object({
  poolId: idSchema.nullable(),
  role: membershipRoleSchema.nullable(),
  previousDriveId: idSchema.nullable(),
});
export type AssignmentDefaults = z.infer<typeof assignmentDefaultsSchema>;
