import { z } from 'zod';
import { timestampSchema } from './common.js';
import { storedActivitySchema } from './activity.js';
import { driveConflictSchema } from './conflict.js';
import { storedDriveSchema } from './drive.js';
import { installationSchema } from './installation.js';
import { enclosureSchema, gridSchema, slotSchema } from './layout.js';
import { poolSchema } from './pool.js';

/** R42: the format marker that identifies a Sparrow export file. */
export const EXPORT_FORMAT = 'sparrow-export' as const;

/**
 * R42: the export schema version. Bump it when the file layout changes.
 * Version 3 (2026-10-12) holds installations instead of memberships and slot ids on drives, and an
 * activity log with nested atomic events; version 1 and 2 files come from pre-release builds and are
 * rejected. Version 4 (2026-10-30, R78) adds `driveConflicts`; a version 3 file still imports (it has
 * no pairs).
 */
export const EXPORT_SCHEMA_VERSION = 4;
/** The oldest export version an import accepts (R42, R78). */
export const MIN_IMPORT_SCHEMA_VERSION = 3;

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
    drives: z.array(storedDriveSchema),
    /** The drives that are installed right now: the bay, the date and the pool of each (R29, D7). */
    installations: z.array(installationSchema),
    pools: z.array(poolSchema),
    /** R78: pairs of drives that are not recommended together (absent in version 3 files). */
    driveConflicts: z.array(driveConflictSchema),
    /** The history, in `seq` order, each activity with its events nested in order. */
    activities: z.array(storedActivitySchema),
    appMeta: z.array(appMetaEntrySchema),
  }),
});
export type ExportFile = z.infer<typeof exportFileSchema>;
export type ExportData = ExportFile['data'];
