/**
 * R18, R47: an observation older than the stale threshold is shown as stale, with its last known
 * health, never as live. The threshold comes from GET /api/status (staleAfterHours); unknown means
 * we cannot tell, so nothing is called stale.
 */
export function isObservationStale(
  lastReportedAt: string | null | undefined,
  staleAfterHours: number | null | undefined,
  now: number = Date.now(),
): boolean {
  if (!staleAfterHours) return false;
  if (!lastReportedAt) return true;
  const then = Date.parse(lastReportedAt);
  if (Number.isNaN(then)) return true;
  return now - then > staleAfterHours * 3_600_000;
}
