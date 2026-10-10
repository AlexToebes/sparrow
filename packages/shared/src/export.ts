import { z } from 'zod';
import { timestampSchema } from './common.js';
import { driveSchema } from './drive.js';
import { enclosureSchema, gridSchema, slotSchema } from './layout.js';
import { eventSchema } from './event.js';
import { membershipSchema, poolSchema } from './pool.js';

/** R42: the format marker that identifies a Sparrow export file. */
export const EXPORT_FORMAT = 'sparrow-export' as const;

/**
 * R42: the export schema version. Bump it when the file layout changes.
 * An import accepts versions up to and including this value and rejects newer ones.
 */
export const EXPORT_SCHEMA_VERSION = 1;

/** One app_meta row (for example the layout-seeded flag from R5). */
export const appMetaEntrySchema = z.object({
  key: z.string().min(1),
  value: z.string(),
});
export type AppMetaEntry = z.infer<typeof appMetaEntrySchema>;

/**
 * R41, R42: all app data as one JSON document. The provider snapshot cache is deliberately absent:
 * it is derived from the provider, not user data.
 */
export const exportFileSchema = z.object({
  format: z.literal(EXPORT_FORMAT),
  schemaVersion: z.literal(EXPORT_SCHEMA_VERSION),
  exportedAt: timestampSchema,
  data: z.object({
    enclosures: z.array(enclosureSchema),
    grids: z.array(gridSchema),
    slots: z.array(slotSchema),
    drives: z.array(driveSchema),
    pools: z.array(poolSchema),
    memberships: z.array(membershipSchema),
    events: z.array(eventSchema),
    appMeta: z.array(appMetaEntrySchema),
  }),
});
export type ExportFile = z.infer<typeof exportFileSchema>;
export type ExportData = ExportFile['data'];
