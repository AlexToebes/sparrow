import { dateSchema } from '@sparrow/shared';
import { invalid } from './errors.js';

// R68: the installation date is a calendar date (YYYY-MM-DD) that may be backdated but never lie
// in the future. "Today" is judged generously: a browser ahead of UTC (for example UTC+13) may
// legitimately send tomorrow's UTC date, so anything up to UTC today + 1 day is accepted.

const DAY_MS = 86_400_000;

export const todayUtc = (now: Date = new Date()): string => now.toISOString().slice(0, 10);

/** Validates an installation date and returns it. Throws a 400 `invalid` for a malformed or future date. */
export function parseInstalledOn(value: string, now: Date = new Date()): string {
  if (!dateSchema.safeParse(value).success) {
    throw invalid('installedOn must be a valid date (YYYY-MM-DD)');
  }
  const latest = todayUtc(new Date(now.getTime() + DAY_MS));
  if (value > latest) throw invalid('installedOn must not be in the future');
  return value;
}

/**
 * The membership start that goes with an installation date: the moment of the change when the date
 * is today (so same-day ordering against the other events holds), else midnight UTC of that date.
 * `userSupplied` is true when the start differs from "now" and must be carried in the event payload.
 */
export function startOfInstalledOn(
  date: string,
  now: Date = new Date(),
): { startedAt: string; userSupplied: boolean } {
  return date >= todayUtc(now)
    ? { startedAt: now.toISOString(), userSupplied: false }
    : { startedAt: `${date}T00:00:00.000Z`, userSupplied: true };
}
