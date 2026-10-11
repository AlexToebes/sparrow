export type PoolSizeCheck = 'ok' | 'fewer' | 'more';

/** R34: the wording for a pool's size check, or null when the pool has no expected size. */
export function sizeCheckText(
  check: PoolSizeCheck | null,
  memberCount: number,
  expected: number | null,
): string | null {
  if (check === null || expected === null) return null;
  if (check === 'fewer') {
    const missing = expected - memberCount;
    return `${memberCount} of ${expected} drives — ${missing === 1 ? 'one' : missing} missing`;
  }
  if (check === 'more')
    return `${memberCount} ${memberCount === 1 ? 'drive' : 'drives'}, expected ${expected}`;
  return `${memberCount} of ${expected} drives`;
}
