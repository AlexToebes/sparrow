import type { FastifyPluginAsync } from 'fastify';
import { getSlotCompatibility } from '../core/compatibility.js';
import type { AppDb } from '../db/client.js';

/** R12: GET /api/slots/:id/compatibility. Thin: call, return. */
export const compatibilityRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, opts) => {
  app.get<{ Params: { id: string } }>('/api/slots/:id/compatibility', async (req) =>
    getSlotCompatibility(opts.db, req.params.id),
  );
};
