import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';
import { membershipRoleSchema } from './enums.js';

// Request bodies for pools and pool membership (R29, R30, R35, R36). The source is always manual (R31).

const name = z.string().trim().min(1, 'Name is required');
const layoutLabel = z.string().trim().min(1).nullish();

/** POST /api/pools. */
export const createPoolInputSchema = z.strictObject({
  name,
  layoutLabel,
});
export type CreatePoolInput = z.infer<typeof createPoolInputSchema>;

/** PATCH /api/pools/:id. At least one field is required. */
export const updatePoolInputSchema = z
  .strictObject({
    name: name.optional(),
    layoutLabel,
  })
  .refine((v) => v.name !== undefined || v.layoutLabel !== undefined, {
    message: 'Nothing to update',
  });
export type UpdatePoolInput = z.infer<typeof updatePoolInputSchema>;

/** POST /api/drives/:id/membership. Role defaults to data (R35); startedAt defaults to now. */
export const joinPoolInputSchema = z.strictObject({
  poolId: idSchema,
  role: membershipRoleSchema.optional(),
  startedAt: timestampSchema.optional(),
});
export type JoinPoolInput = z.infer<typeof joinPoolInputSchema>;

/** PATCH /api/drives/:id/membership. Role change on the same pool, or move to another pool. */
export const changeMembershipInputSchema = z
  .strictObject({
    poolId: idSchema.optional(),
    role: membershipRoleSchema.optional(),
  })
  .refine((v) => v.poolId !== undefined || v.role !== undefined, {
    message: 'Nothing to change',
  });
export type ChangeMembershipInput = z.infer<typeof changeMembershipInputSchema>;

/** DELETE /api/drives/:id/membership. Ends the open membership; history is kept. */
export const leavePoolInputSchema = z.strictObject({
  endedAt: timestampSchema.optional(),
});
export type LeavePoolInput = z.infer<typeof leavePoolInputSchema>;
