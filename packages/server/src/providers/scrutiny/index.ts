import type { Observation } from '@sparrow/shared';
import type { DriveDataProvider } from '../port.js';
import { loadScrutinyConfig } from './config.js';
import { mapSummary } from './mapping.js';

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Scrutiny's collector runs on a cron that defaults to daily (`0 0 * * *`), so data is expected
 * to refresh every 24 hours. The derived stale threshold is 1.5x this (36 h, Appendix C).
 */
const EXPECTED_UPDATE_INTERVAL_HOURS = 24;

export function createScrutinyProvider(env: Record<string, string | undefined>): DriveDataProvider {
  const config = loadScrutinyConfig(env);

  async function getSummary(): Promise<unknown> {
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (config.token) headers.Authorization = `Bearer ${config.token}`;
    // R46: unpaginated summary. Global fetch is looked up per call so tests can stub it.
    const res = await fetch(`${config.baseUrl}/api/summary`, {
      headers,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`Scrutiny responded with HTTP ${res.status}`);
    return res.json();
  }

  return {
    id: 'scrutiny',
    capabilities: { drives: true, pools: false },
    expectedUpdateIntervalHours: EXPECTED_UPDATE_INTERVAL_HOURS,
    async fetchSnapshot(): Promise<Observation[]> {
      return mapSummary(await getSummary(), config.baseUrl);
    },
    async checkConnection() {
      try {
        mapSummary(await getSummary(), config.baseUrl);
        return { ok: true as const };
      } catch (e) {
        return { ok: false as const, error: e instanceof Error ? e.message || 'Request failed' : 'Request failed' };
      }
    },
  };
}
