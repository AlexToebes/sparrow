import { z } from 'zod';
import { dateSchema, idSchema, timestampSchema } from './common.js';
import {
  driveConditionSchema,
  driveStatusSchema,
  driveTypeSchema,
  retirementReasonSchema,
} from './enums.js';

export const driveSchema = z
  .object({
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
    status: driveStatusSchema,
    slotId: idSchema.nullable(),
    retirementReason: retirementReasonSchema.nullable(),
    /** R60: calendar date of the retirement; null on a retired drive means "not recorded". */
    retirementDate: dateSchema.nullable(),
    replacedByDriveId: idSchema.nullable(),
    retirementNote: z.string().max(5000).nullable(),
    /**
     * R68: calendar date the drive was installed in its slot. Non-null only while installed; null
     * on an installed drive means "installation date not recorded" (never guessed).
     */
    installedOn: dateSchema.nullable(),
    createdAt: timestampSchema,
    updatedAt: timestampSchema,
  })
  .superRefine((d, ctx) => {
    if (d.status === 'installed' && d.slotId === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['slotId'],
        message: 'slotId is required when installed',
      });
    }
    if (d.status !== 'installed' && d.slotId !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['slotId'],
        message: 'slotId is only allowed when installed',
      });
    }
    if (d.status !== 'installed' && d.installedOn !== null) {
      ctx.addIssue({
        code: 'custom',
        path: ['installedOn'],
        message: 'installedOn is only allowed when installed',
      });
    }
    // R60: a retired drive needs its reason; the date may be null ("not recorded", never guessed).
    if (d.status === 'retired' && d.retirementReason === null) {
      ctx.addIssue({
        code: 'custom',
        path: ['retirementReason'],
        message: 'required when retired',
      });
    }
    if (d.replacedByDriveId !== null && d.replacedByDriveId === d.id) {
      ctx.addIssue({
        code: 'custom',
        path: ['replacedByDriveId'],
        message: 'a drive cannot replace itself',
      });
    }
  });
export type Drive = z.infer<typeof driveSchema>;
