import type { Observation } from '@sparrow/shared';

/**
 * The port every drive-data adapter implements (ports and adapters). It lives in the core so the
 * core never imports provider code; `src/providers/port.ts` re-exports it.
 * Pools are optional and arrive in Step 9.
 */
export interface DriveDataProvider {
  /** Stable, non-empty identifier. Cached snapshots are tagged with it (R55). */
  id: string;
  capabilities: { drives: true; pools: boolean };
  expectedUpdateIntervalHours: number;
  /** May throw or reject on failure; the poller turns that into a stale snapshot (R18). */
  fetchSnapshot(): Promise<Observation[]>;
  /** Reports connectivity as a result; must never reject. */
  checkConnection(): Promise<{ ok: true } | { ok: false; error: string }>;
}
