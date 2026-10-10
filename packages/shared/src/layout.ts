import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';
import { gridOrientationSchema } from './enums.js';

export const enclosureSchema = z.object({
  id: idSchema,
  name: z.string().min(1).max(100),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Enclosure = z.infer<typeof enclosureSchema>;

export const gridSchema = z.object({
  id: idSchema,
  enclosureId: idSchema,
  name: z.string().min(1).max(100),
  rows: z.number().int().min(1),
  columns: z.number().int().min(1),
  orientation: gridOrientationSchema,
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Grid = z.infer<typeof gridSchema>;

export const slotSchema = z.object({
  id: idSchema,
  gridId: idSchema,
  position: z.number().int().min(0),
  label: z.string().max(50).nullable(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
});
export type Slot = z.infer<typeof slotSchema>;
