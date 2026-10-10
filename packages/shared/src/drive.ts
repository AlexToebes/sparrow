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
    serial: z.string().min(1),
    serialNormalized: z.string().min(1),
    model: z.string().nullable(),
    capacityBytes: z.number().int().min(0).nullable(),
    driveType: driveTypeSchema.nullable(),
    formFactor: z.string().nullable(),
    storageLocation: z.string().nullable(),
    condition: driveConditionSchema.nullable(),
    lastTestDate: dateSchema.nullable(),
    purchaseDate: dateSchema.nullable(),
    warrantyExpiry: dateSchema.nullable(),
    vendor: z.string().nullable(),
    notes: z.string().nullable(),
    status: driveStatusSchema,
    slotId: idSchema.nullable(),
    retirementReason: retirementReasonSchema.nullable(),
    retirementDate: dateSchema.nullable(),
    replacedByDriveId: idSchema.nullable(),
    retirementNote: z.string().nullable(),
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
    if (d.status === 'retired') {
      if (d.retirementReason === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['retirementReason'],
          message: 'required when retired',
        });
      }
      if (d.retirementDate === null) {
        ctx.addIssue({
          code: 'custom',
          path: ['retirementDate'],
          message: 'required when retired',
        });
      }
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
