import type { FastifyPluginAsync } from 'fastify';
import { setupInputSchema } from '@sparrow/shared';
import { completeSetup, getSetupState, skipSetup } from '../core/setup.js';
import type { AppDb } from '../db/client.js';

/** First-run setup wizard routes (R77). Thin: parse, call the service, return. */
export const setupRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, opts) => {
  const { db } = opts;

  app.get('/api/setup', async () => ({ state: getSetupState(db) }));

  app.post('/api/setup', async (req, reply) =>
    reply.status(201).send(completeSetup(db, setupInputSchema.parse(req.body))),
  );

  app.post('/api/setup/skip', async (_req, reply) => {
    skipSetup(db);
    return reply.status(200).send({ state: 'skipped' });
  });
};
