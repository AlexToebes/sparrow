import type { DriveDataProvider } from '../core/provider-port.js';

/**
 * Stand-in used by buildApp when no provider is passed (tests, tools). It behaves like the `none`
 * adapter but is defined here so the API layer does not import from providers/*; main.ts wires the
 * real provider through the registry.
 */
export const noProvider: DriveDataProvider = {
  id: 'none',
  capabilities: { drives: true, pools: false },
  expectedUpdateIntervalHours: 24,
  fetchSnapshot: async () => [],
  checkConnection: async () => ({ ok: true }),
};
