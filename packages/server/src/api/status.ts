import type { FastifyPluginAsync } from 'fastify';
import { computeSlotStatus } from '../core/health-status.js';
import type { AppDb } from '../db/client.js';

/** GET /api/status (R10, R27, R28, R47). Read-only: computes flags on every request. Thin route. */
export const statusRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, { db }) => {
  app.get('/api/status', async () => {
    const { provider, staleAfterHours } = app;
    const result = computeSlotStatus(db, {
      now: new Date(),
      staleAfterHours,
      providerId: provider.id,
    });
    return {
      providerId: provider.id,
      providerStale: result.providerStale,
      staleAfterHours,
      lastSuccessAt: result.lastSuccessAt,
      slots: result.slots,
    };
  });
};
