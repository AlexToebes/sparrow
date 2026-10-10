import type { DriveDataProvider } from '../port.js';

/** No provider: no observations, always reachable. */
export function createNoneProvider(): DriveDataProvider {
  return {
    id: 'none',
    capabilities: { drives: true, pools: false },
    expectedUpdateIntervalHours: 24,
    fetchSnapshot: async () => [],
    checkConnection: async () => ({ ok: true }),
  };
}
