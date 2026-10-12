import { z } from 'zod';
import { dateSchema, idSchema } from './common.js';
import { membershipRoleSchema } from './enums.js';

/**
 * R29, D7: the relationship between a drive and the bay it sits in. The pool and the pool role are
 * properties of this relationship, not of the drive or the bay. The row exists only while the drive
 * is installed (removing the drive deletes it; the history lives in the activity log). The drive id
 * is the key and the bay is unique, so a drive has at most one installation, a bay holds at most one,
 * and a drive is in at most one pool.
 */
export const installationSchema = z
  .object({
    driveId: idSchema,
    slotId: idSchema,
    poolId: idSchema.nullable(),
    poolRole: membershipRoleSchema.nullable(),
    /** R68: the day it went in; null = not recorded. */
    installedOn: dateSchema.nullable(),
  })
  .superRefine((i, ctx) => {
    if ((i.poolId === null) !== (i.poolRole === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['poolRole'],
        message: 'poolId and poolRole are set together',
      });
    }
  });
export type Installation = z.infer<typeof installationSchema>;
