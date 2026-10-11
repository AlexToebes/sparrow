import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';
import { membershipRoleSchema, membershipSourceSchema } from './enums.js';

export const poolSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(100),
  layoutLabel: z.string().max(50).nullable(),
  /** Expected number of drives in the pool (R34, R72). Null when not set. */
  expectedMembers: z.number().int().min(1).max(100).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Pool = z.infer<typeof poolSchema>;

export const membershipSchema = z
  .object({
    id: idSchema,
    driveId: idSchema,
    poolId: idSchema,
    role: membershipRoleSchema,
    source: membershipSourceSchema,
    startedAt: timestampSchema,
    endedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
  })
  .refine((m) => m.endedAt === null || m.endedAt >= m.startedAt, {
    path: ['endedAt'],
    message: 'endedAt must not be before startedAt',
  });
export type Membership = z.infer<typeof membershipSchema>;
