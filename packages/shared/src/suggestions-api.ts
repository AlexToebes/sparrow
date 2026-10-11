import { z } from 'zod';
import { idSchema } from './common.js';

// Suggested updates (R72): fields a matched observation could fill in or disagrees about.
// Computed on every read from the drive record and the cached snapshot, never stored (R54).

/** The R11 fields an observation can inform (Appendix A). */
export const suggestionFieldSchema = z.enum([
  'model',
  'capacityBytes',
  'driveType',
  'formFactor',
  'wwn',
]);
export type SuggestionField = z.infer<typeof suggestionFieldSchema>;

export const suggestionValueSchema = z.union([z.string(), z.number()]);

export const suggestionSchema = z.object({
  field: suggestionFieldSchema,
  /** fill: the record has no value. differs: both have one and they disagree. */
  kind: z.enum(['fill', 'differs']),
  current: suggestionValueSchema.nullable(),
  suggested: suggestionValueSchema,
});
export type Suggestion = z.infer<typeof suggestionSchema>;

/** GET /api/drives/:id/suggestions. */
export const driveSuggestionsResponseSchema = z.object({
  suggestions: z.array(suggestionSchema),
  /** Suggestions the owner dismissed that are still being reported with the same value. */
  dismissed: z.array(suggestionSchema).default([]),
});
export type DriveSuggestionsResponse = z.infer<typeof driveSuggestionsResponseSchema>;

/** GET /api/suggestions: only drives with at least one suggestion appear. */
export const suggestionSummaryResponseSchema = z.object({
  byDriveId: z.record(
    idSchema,
    z.object({
      fill: z.number().int().min(0),
      differs: z.number().int().min(0),
      /** The fields of the "fill" suggestions, for lists that name them. */
      fillFields: z.array(suggestionFieldSchema),
    }),
  ),
});
export type SuggestionSummaryResponse = z.infer<typeof suggestionSummaryResponseSchema>;

/** POST /api/drives/:id/suggestions/apply. Applies the suggested values as they are NOW. */
export const applySuggestionsInputSchema = z.strictObject({
  fields: z.array(suggestionFieldSchema).min(1),
});
export type ApplySuggestionsInput = z.infer<typeof applySuggestionsInputSchema>;

/** POST /api/drives/:id/suggestions/dismiss: hides the suggestions as they are NOW (R72). */
export const dismissSuggestionsInputSchema = z.strictObject({
  fields: z.array(suggestionFieldSchema).min(1),
});
export type DismissSuggestionsInput = z.infer<typeof dismissSuggestionsInputSchema>;

/** POST /api/drives/:id/suggestions/undismiss: shows dismissed suggestions again (R72). */
export const undismissSuggestionsInputSchema = dismissSuggestionsInputSchema;
export type UndismissSuggestionsInput = DismissSuggestionsInput;
