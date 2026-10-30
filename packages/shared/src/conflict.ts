import { z } from 'zod';
import { idSchema, timestampSchema } from './common.js';
import { driveStatusSchema } from './enums.js';

// R78: two drives marked "not recommended together" (same batch, same purchase, same failure history).
// A symmetric pair, stored once. Advice only: computed on every read, never blocks an action.

/** The longest reason text; a short note such as "same batch". */
export const CONFLICT_REASON_MAX = 200;

/** Suggestions the UI offers as chips; the reason is free text. */
export const CONFLICT_REASON_SUGGESTIONS = [
  'Same batch',
  'Same purchase',
  'Same failure history',
] as const;

const reason = z
  .string()
  .trim()
  .max(CONFLICT_REASON_MAX, `At most ${CONFLICT_REASON_MAX} characters`)
  .nullish()
  .transform((v) => (v === undefined || v === null || v === '' ? null : v));

/** A stored pair as exported (R41): `driveAId` sorts before `driveBId`. */
export const driveConflictSchema = z.object({
  driveAId: idSchema,
  driveBId: idSchema,
  reason: z.string().min(1).max(CONFLICT_REASON_MAX).nullable(),
  createdAt: timestampSchema,
});
export type DriveConflict = z.infer<typeof driveConflictSchema>;

/** POST /api/drives/:id/conflicts. */
export const addConflictInputSchema = z.strictObject({
  otherDriveId: idSchema,
  reason,
});
export type AddConflictInput = z.input<typeof addConflictInputSchema>;

/** One pair as the drive's detail shows it: the OTHER drive, and why. GET /api/drives/:id/conflicts. */
export const driveConflictViewSchema = z.object({
  otherDriveId: idSchema,
  serial: z.string(),
  model: z.string().nullable(),
  capacityBytes: z.number().nullable(),
  status: driveStatusSchema,
  /** "Front bays, Bay 3" for an installed drive; null otherwise. */
  where: z.string().nullable(),
  reason: z.string().nullable(),
  createdAt: timestampSchema,
});
export type DriveConflictView = z.infer<typeof driveConflictViewSchema>;
export const driveConflictViewsSchema = z.array(driveConflictViewSchema);

/** A pair of CURRENT pool members that are not recommended together (R78). */
export const poolConflictSchema = z.object({
  driveAId: idSchema,
  serialA: z.string(),
  driveBId: idSchema,
  serialB: z.string(),
  reason: z.string().nullable(),
});
export type PoolConflict = z.infer<typeof poolConflictSchema>;

/** A spare's conflict with a current member of the pool it would join (R78, R12). */
export const spareConflictSchema = z.object({
  /** The member the spare is not recommended with. */
  driveId: idSchema,
  serial: z.string(),
  reason: z.string().nullable(),
});
export type SpareConflict = z.infer<typeof spareConflictSchema>;

/** Lower-cases the first letter so a reason reads inside a sentence ("Same batch" -> "same batch"). */
const inSentence = (text: string): string => text.replace(/^./, (ch) => ch.toLowerCase());

/** The text of a pool warning: "WD-A and WD-B are not recommended together (same batch)". */
export function poolConflictText(c: Pick<PoolConflict, 'serialA' | 'serialB' | 'reason'>): string {
  return `${c.serialA} and ${c.serialB} are not recommended together${
    c.reason ? ` (${inSentence(c.reason)})` : ''
  }`;
}

/** The text of a spare's warning: "Not recommended with WD-B: same batch". */
export function spareConflictText(c: Pick<SpareConflict, 'serial' | 'reason'>): string {
  return `Not recommended with ${c.serial}${c.reason ? `: ${inSentence(c.reason)}` : ''}`;
}
