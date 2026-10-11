import type { Suggestion, SuggestionField } from '@sparrow/shared';
import { formatBytes } from './format';

/** Our own labels (R53): never the provider's field names. */
export const FIELD_LABEL: Record<SuggestionField, string> = {
  model: 'Model',
  capacityBytes: 'Capacity',
  driveType: 'Type',
  formFactor: 'Form factor',
  wwn: 'WWN',
};

/** Capacity in decimal units (D4); everything else as text. */
export function formatSuggestionValue(field: SuggestionField, value: string | number | null) {
  if (value === null) return 'not recorded';
  return field === 'capacityBytes' && typeof value === 'number'
    ? formatBytes(value) || String(value)
    : String(value);
}

/** "model, capacity" for a list of fields. */
export const fieldList = (fields: readonly SuggestionField[]): string =>
  fields.map((f) => FIELD_LABEL[f].toLowerCase()).join(', ');

export const isFill = (s: Suggestion) => s.kind === 'fill';
