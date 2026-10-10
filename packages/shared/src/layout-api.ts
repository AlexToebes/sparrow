import { z } from 'zod';
import { idSchema } from './common.js';
import { enclosureSchema, gridSchema, slotSchema } from './layout.js';
import { gridOrientationSchema } from './enums.js';

/** R38: names are trimmed and must not be empty. */
export const layoutNameSchema = z.string().trim().min(1).max(100);

/** R39: slot labels are free text. An empty label clears it (stored as null). */
export const slotLabelSchema = z
  .string()
  .trim()
  .max(50)
  .transform((value) => (value === '' ? null : value));

/** Grid rows and columns. The cap keeps a typo from creating thousands of slots. */
export const gridDimensionSchema = z.number().int().min(1).max(100);

// Request bodies
export const createEnclosureSchema = z.object({ name: layoutNameSchema });
export type CreateEnclosureInput = z.infer<typeof createEnclosureSchema>;

export const createGridSchema = z.object({
  name: layoutNameSchema,
  rows: gridDimensionSchema,
  columns: gridDimensionSchema,
  orientation: gridOrientationSchema,
});
export type CreateGridInput = z.infer<typeof createGridSchema>;

export const updateGridSchema = z
  .object({
    name: layoutNameSchema.optional(),
    rows: gridDimensionSchema.optional(),
    columns: gridDimensionSchema.optional(),
    orientation: gridOrientationSchema.optional(),
  })
  .refine((value) => Object.keys(value).length > 0, {
    message: 'Provide at least one field to change',
  });
export type UpdateGridInput = z.infer<typeof updateGridSchema>;

export const updateSlotSchema = z.object({ label: slotLabelSchema });
export type UpdateSlotInput = z.infer<typeof updateSlotSchema>;

// Responses
/** driveId is the occupant's drive ID, or null when the slot is empty. */
export const layoutSlotSchema = slotSchema.extend({ driveId: idSchema.nullable() });
export const layoutGridSchema = gridSchema.extend({ slots: z.array(layoutSlotSchema) });
export const layoutEnclosureSchema = enclosureSchema.extend({
  grids: z.array(layoutGridSchema),
});
export const layoutSchema = z.object({ enclosures: z.array(layoutEnclosureSchema) });
export type LayoutSlot = z.infer<typeof layoutSlotSchema>;
export type LayoutGrid = z.infer<typeof layoutGridSchema>;
export type LayoutEnclosure = z.infer<typeof layoutEnclosureSchema>;
export type Layout = z.infer<typeof layoutSchema>;
