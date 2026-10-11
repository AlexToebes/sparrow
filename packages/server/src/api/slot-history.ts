import type { FastifyPluginAsync } from 'fastify';
import { getSlotHistory } from '../core/slot-history.js';
import type { AppDb } from '../db/client.js';

/** R74: GET /api/slots/:id/history. Thin: call, return. */
export const slotHistoryRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, opts) => {
  app.get<{ Params: { id: string } }>('/api/slots/:id/history', async (req) =>
    getSlotHistory(opts.db, req.params.id),
  );
};
