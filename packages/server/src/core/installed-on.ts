import { dateSchema } from '@sparrow/shared';
import { invalid } from './errors.js';

// R68: the installation date is a calendar date (YYYY-MM-DD) that may be backdated but never lie
// in the future. "Today" is judged generously: a browser ahead of UTC (for example UTC+13) may
// legitimately send tomorrow's UTC date, so anything up to UTC today + 1 day is accepted.

const DAY_MS = 86_400_000;

export const todayUtc = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/**
 * Validates a calendar date that must not lie in the future (R68 installation date, R69 removal date)
 * and returns it. Throws a 400 `invalid` naming `field` for a malformed or future date.
 */
export function parseNotFutureDate(field: string, value: string, now: Date = new Date()): string {
  if (!dateSchema.safeParse(value).success) {
    throw invalid(`${field} must be a valid date (YYYY-MM-DD)`);
  }
  const latest = todayUtc(new Date(now.getTime() + DAY_MS));
  if (value > latest) throw invalid(`${field} must not be in the future`);
  return value;
}

/** Validates an installation date and returns it. Throws a 400 `invalid` for a malformed or future date. */
export function parseInstalledOn(value: string, now: Date = new Date()): string {
  return parseNotFutureDate('installedOn', value, now);
}
