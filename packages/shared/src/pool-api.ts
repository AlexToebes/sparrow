import { z } from 'zod';
import { dateSchema, idSchema, timestampSchema } from './common.js';
import { membershipRoleSchema } from './enums.js';
import { poolSchema } from './pool.js';

// Request bodies for pools and pool membership (R29, R30, R35, R36). Membership is the pool and role
// of a drive's installation; the user's date, when given, becomes the activity's occurred-on date.

const name = z.string().trim().min(1, 'Name is required').max(100);
const layoutLabel = z.string().trim().min(1).max(50).nullish();
const expectedMembers = z.number().int().min(1).max(100).nullish();

/** POST /api/pools. */
export const createPoolInputSchema = z.strictObject({
  name,
  layoutLabel,
  expectedMembers,
});
export type CreatePoolInput = z.infer<typeof createPoolInputSchema>;

/** PATCH /api/pools/:id. At least one field is required. */
export const updatePoolInputSchema = z
  .strictObject({
    name: name.optional(),
    layoutLabel,
    expectedMembers,
  })
  .refine(
    (v) => v.name !== undefined || v.layoutLabel !== undefined || v.expectedMembers !== undefined,
    {
      message: 'Nothing to update',
    },
  );
export type UpdatePoolInput = z.infer<typeof updatePoolInputSchema>;

/** POST /api/drives/:id/membership. Role defaults to data (R35); startedAt (optional) is recorded as the activity's date. */
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

/** DELETE /api/drives/:id/membership. Takes the drive out of its pool; the activity log keeps the history. */
export const leavePoolInputSchema = z.strictObject({
  endedAt: timestampSchema.optional(),
});
export type LeavePoolInput = z.infer<typeof leavePoolInputSchema>;

// Response shapes of GET /api/pools and GET /api/pools/:id (R29, R30, R34, R68). The server's core
// types mirror these; a server test parses the real responses with them.

/** R34: how the member count compares with the expected one. */
export const poolSizeCheckSchema = z.enum(['ok', 'fewer', 'more']);
export type PoolSizeCheck = z.infer<typeof poolSizeCheckSchema>;

export const poolSummarySchema = poolSchema.extend({
  memberCount: z.number().int().min(0),
  /** R34: null when the pool has no expected size. */
  sizeCheck: poolSizeCheckSchema.nullable(),
  /** R12: the usable per-disk size (smallest current member with a known capacity); null if none. */
  smallestMemberBytes: z.number().nullable(),
  /** R12: how many spares on the shelf fit a bay of this pool. */
  sparesFit: z.number().int().min(0),
});
export type PoolSummary = z.infer<typeof poolSummarySchema>;

/** Members are the drives installed in a bay with this pool (R29). */
export const poolDetailSchema = poolSummarySchema.extend({
  members: z.array(
    z.object({
      driveId: idSchema,
      serial: z.string(),
      capacityBytes: z.number().nullable(),
      role: membershipRoleSchema,
      /** R68: null = not recorded. */
      installedOn: dateSchema.nullable(),
      slotId: idSchema,
      slotLabel: z.string(),
    }),
  ),
});
export type PoolDetail = z.infer<typeof poolDetailSchema>;
