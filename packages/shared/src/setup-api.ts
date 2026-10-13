import { z } from 'zod';
import { idSchema } from './common.js';
import { gridOrientationSchema } from './enums.js';
import { gridDimensionSchema, layoutNameSchema, slotLabelSchema } from './layout-api.js';
import { createPoolInputSchema } from './pool-api.js';

// First-run setup wizard (R77): one request creates the enclosure, its grids (with slots and bay
// labels) and optional pools, all in one transaction and one activity.

/** GET /api/setup: `needed` shows the wizard; `skipped` and `done` show the plain layout page. */
export const setupStateSchema = z.enum(['needed', 'skipped', 'done']);
export type SetupState = z.infer<typeof setupStateSchema>;
export const setupStateResponseSchema = z.object({ state: setupStateSchema });
export type SetupStateResponse = z.infer<typeof setupStateResponseSchema>;

export const setupGridSchema = z
  .object({
    name: layoutNameSchema,
    rows: gridDimensionSchema,
    columns: gridDimensionSchema,
    orientation: gridOrientationSchema,
    /** One label per bay in position order; an empty label clears it. Omitted = no labels. */
    labels: z.array(slotLabelSchema).optional(),
  })
  .refine((g) => g.labels === undefined || g.labels.length === g.rows * g.columns, {
    message: 'Give one label per bay (rows x columns)',
    path: ['labels'],
  });
export type SetupGridInput = z.input<typeof setupGridSchema>;

export const SETUP_MAX_GRIDS = 20;
export const SETUP_MAX_POOLS = 50;

/** POST /api/setup. Grid names and pool names must be unique. */
export const setupInputSchema = z
  .object({
    enclosureName: layoutNameSchema,
    grids: z.array(setupGridSchema).min(1, 'Add at least one grid').max(SETUP_MAX_GRIDS),
    pools: z.array(createPoolInputSchema).max(SETUP_MAX_POOLS).default([]),
  })
  .superRefine((value, ctx) => {
    const dupe = (names: string[]) => names.find((n, i) => names.indexOf(n) !== i);
    const grid = dupe(value.grids.map((g) => g.name));
    if (grid !== undefined) {
      ctx.addIssue({ code: 'custom', message: `Two grids are named "${grid}"`, path: ['grids'] });
    }
    const pool = dupe(value.pools.map((p) => p.name));
    if (pool !== undefined) {
      ctx.addIssue({ code: 'custom', message: `Two pools are named "${pool}"`, path: ['pools'] });
    }
  });
export type SetupInput = z.input<typeof setupInputSchema>;
export type ParsedSetupInput = z.output<typeof setupInputSchema>;

export const setupResultSchema = z.object({
  enclosureId: idSchema,
  gridIds: z.array(idSchema),
  poolIds: z.array(idSchema),
});
export type SetupResult = z.infer<typeof setupResultSchema>;
