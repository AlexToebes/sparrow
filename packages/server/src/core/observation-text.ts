import { DRIVE_TEXT_MAX } from '@sparrow/shared';

// Text that comes from a provider observation must fit the drive record's fields (the shared schema
// caps them), or creating, linking and filling would fail on a long model string. Everything derived
// from an observation goes through here, including the R72 suggestions, so a truncated stored value
// compares equal to the (equally truncated) observed one and never shows as a perpetual "differs".

export type ObservedTextField = keyof typeof DRIVE_TEXT_MAX;

/** Trims, cuts to the field's limit (never inside a surrogate pair) and returns undefined when empty. */
export function fitObservedText(
  field: ObservedTextField,
  value: string | null | undefined,
): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  const max = DRIVE_TEXT_MAX[field];
  if (trimmed.length <= max) return trimmed;
  let cut = trimmed.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1); // a lone high surrogate
  return cut.trimEnd();
}
