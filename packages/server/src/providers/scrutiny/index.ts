import type { Observation } from '@sparrow/shared';
import type { DriveDataProvider } from '../port.js';
import { loadScrutinyConfig } from './config.js';
import { mapSummary } from './mapping.js';

const REQUEST_TIMEOUT_MS = 15_000;
/** The real summary is a few hundred kB; anything beyond this is not a Scrutiny summary. */
export const MAX_RESPONSE_BYTES = 20 * 1024 * 1024;

/** Reads the body as text, failing as soon as it exceeds the cap (also when no Content-Length). */
async function readLimitedText(res: Response): Promise<string> {
  const tooBig = () =>
    new Error(
      `Scrutiny response is larger than ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB; refusing to read it`,
    );
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) throw tooBig();
  if (!res.body) return '';
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    received += value.byteLength;
    if (received > MAX_RESPONSE_BYTES) {
      await reader.cancel();
      throw tooBig();
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

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
    const text = await readLimitedText(res);
    try {
      return JSON.parse(text);
    } catch {
      throw new Error('Scrutiny sent a response that is not JSON');
    }
  }

  return {
    id: 'scrutiny',
    endpoint: config.baseUrl,
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
        return {
          ok: false as const,
          error: e instanceof Error ? e.message || 'Request failed' : 'Request failed',
        };
      }
    },
  };
}
