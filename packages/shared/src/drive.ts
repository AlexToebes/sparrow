import { z } from 'zod';
import { dateSchema, idSchema, timestampSchema } from './common.js';
import {
  driveConditionSchema,
  driveStatusSchema,
  driveTypeSchema,
  membershipRoleSchema,
  retirementReasonSchema,
} from './enums.js';

const driveFields = {
  id: idSchema,
  serial: z.string().min(1).max(100),
  serialNormalized: z.string().min(1),
  /**
   * R2 fallback identifier, stored on the record. Set when linking or creating from an
   * observation; editable (or clearable) through PATCH /api/drives/:id.
   */
  wwn: z.string().min(1).max(100).nullable(),
  model: z.string().max(200).nullable(),
  capacityBytes: z.number().int().min(0).nullable(),
  driveType: driveTypeSchema.nullable(),
  formFactor: z.string().max(200).nullable(),
  storageLocation: z.string().max(200).nullable(),
  condition: driveConditionSchema.nullable(),
  lastTestDate: dateSchema.nullable(),
  purchaseDate: dateSchema.nullable(),
  warrantyExpiry: dateSchema.nullable(),
  vendor: z.string().max(200).nullable(),
  notes: z.string().max(5000).nullable(),
  /** R60: a drive is retired iff it has a reason. */
  retirementReason: retirementReasonSchema.nullable(),
  /** R60: calendar date of the retirement; null on a retired drive means "not recorded". */
  retirementDate: dateSchema.nullable(),
  retirementNote: z.string().max(5000).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

/** R60: the date and the note only exist together with a reason. */
function checkRetirement(
  d: { retirementReason: unknown; retirementDate: unknown; retirementNote: unknown },
  ctx: z.RefinementCtx,
): void {
  if (d.retirementReason === null) {
    for (const field of ['retirementDate', 'retirementNote'] as const) {
      if (d[field] !== null) {
        ctx.addIssue({
          code: 'custom',
          path: [field],
          message: 'only allowed when retirementReason is set',
        });
      }
    }
  }
}

/**
 * A drive row as stored and exported (R41): identity, specification, purchase and retirement fields.
 * Where the drive sits and in which pool is NOT a property of the drive: it lives in the installation
 * (installation.ts), and the status is derived from it.
 */
export const storedDriveSchema = z.object(driveFields).superRefine(checkRetirement);
export type StoredDrive = z.infer<typeof storedDriveSchema>;

/**
 * A drive as the API returns it: the stored record plus what is computed from its installation.
 * `status` is retired if there is a reason, else installed if the drive has an installation, else
 * spare; `slotId`, `installedOn`, `poolId` and `poolRole` are read from the installation (null when
 * there is none).
 */
export const driveSchema = z
  .object({
    ...driveFields,
    status: driveStatusSchema,
    slotId: idSchema.nullable(),
    /**
     * R68: calendar date the drive was installed in its slot. Non-null only while installed; null
     * on an installed drive means "installation date not recorded" (never guessed).
     */
    installedOn: dateSchema.nullable(),
    poolId: idSchema.nullable(),
    poolRole: membershipRoleSchema.nullable(),
  })
  .superRefine((d, ctx) => {
    checkRetirement(d, ctx);
    if (d.status === 'installed' && d.slotId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['slotId'],
        message: 'slotId is required when installed',
      });
    }
    if (d.status !== 'installed') {
      for (const field of ['slotId', 'installedOn', 'poolId', 'poolRole'] as const) {
        if (d[field] !== null) {
          ctx.addIssue({
            code: 'custom',
            path: [field],
            message: 'only allowed when installed',
          });
        }
      }
    }
    // R60: a retired drive needs its reason; the date may be null ("not recorded", never guessed).
    if (d.status === 'retired' && d.retirementReason === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['retirementReason'],
        message: 'required when retired',
      });
    }
    if ((d.poolId === null) !== (d.poolRole === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['poolRole'],
        message: 'poolId and poolRole are set together',
      });
    }
  });
export type Drive = z.infer<typeof driveSchema>;
