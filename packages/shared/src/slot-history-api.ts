import { z } from 'zod';
import { dateSchema, idSchema, timestampSchema } from './common.js';
import { driveTypeSchema } from './enums.js';

// Response shape for GET /api/slots/:id/history (R74). Computed on every read from the events linked
// to the slot (event_slots), never stored. Entries are newest first.

/** How a drive left the bay. `null` on the entry means it is still there. */
export const slotHistoryOutcomeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('moved'),
    toSlotId: idSchema,
    toLabel: z.string(),
    toGridName: z.string(),
  }),
  /** R73: two drives traded bays; this one went to `toLabel`, the other one came here. */
  z.object({
    kind: z.literal('swapped'),
    withDriveId: idSchema,
    withSerial: z.string(),
    toSlotId: idSchema,
    toLabel: z.string(),
    toGridName: z.string(),
  }),
  z.object({ kind: z.literal('spares') }),
  z.object({ kind: z.literal('retired'), reason: z.string().nullable() }),
  z.object({ kind: z.literal('rma') }),
]);
export type SlotHistoryOutcome = z.infer<typeof slotHistoryOutcomeSchema>;

/** The drive that took the bay when this one left it (a replacement, drive-replaced). */
export const slotHistoryReplacedBySchema = z.object({
  driveId: idSchema,
  serial: z.string(),
  capacityBytes: z.number().int().nullable(),
});
export type SlotHistoryReplacedBy = z.infer<typeof slotHistoryReplacedBySchema>;

export const slotHistoryEntrySchema = z.object({
  driveId: idSchema,
  serial: z.string(),
  capacityBytes: z.number().int().nullable(),
  driveType: driveTypeSchema.nullable(),
  /** R68: the day it went in; null = not recorded. */
  installedOn: dateSchema.nullable(),
  /** When the installation was recorded; null only if the log has a removal with no installation. */
  installedRecordedAt: timestampSchema.nullable(),
  /** R69: the day it left; null = not recorded (or still there). */
  removedOn: dateSchema.nullable(),
  removedRecordedAt: timestampSchema.nullable(),
  /** How it left; null while it is still there. */
  outcome: slotHistoryOutcomeSchema.nullable(),
  /** Set when a replacement took the bay: the outcome then says what became of this drive. */
  replacedBy: slotHistoryReplacedBySchema.nullable(),
});
export type SlotHistoryEntry = z.infer<typeof slotHistoryEntrySchema>;

export const slotHistorySchema = z.object({
  slot: z.object({ id: idSchema, label: z.string(), gridName: z.string() }),
  entries: z.array(slotHistoryEntrySchema),
});
export type SlotHistory = z.infer<typeof slotHistorySchema>;
