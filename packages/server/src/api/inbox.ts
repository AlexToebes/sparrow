import type { FastifyPluginAsync } from 'fastify';
import {
  createFromObservationInputSchema,
  importRetiredInputSchema,
  linkObservationInputSchema,
} from '@sparrow/shared';
import { createFromObservation, getInbox, importRetired, linkObservation } from '../core/inbox.js';
import type { AppDb } from '../db/client.js';

/** Discovery inbox routes (R9, R22 to R25, R58, R63). Thin: parse, call, return. */
export const inboxRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, opts) => {
  const { db } = opts;

  app.get('/api/inbox', async () => getInbox(db));

  app.post('/api/inbox/import-retired', async (req) =>
    importRetired(db, importRetiredInputSchema.parse(req.body)),
  );

  app.post<{ Params: { key: string } }>('/api/inbox/:key/link', async (req) =>
    linkObservation(db, req.params.key, linkObservationInputSchema.parse(req.body)),
  );

  app.post<{ Params: { key: string } }>('/api/inbox/:key/create', async (req, reply) => {
    const result = createFromObservation(
      db,
      req.params.key,
      createFromObservationInputSchema.parse(req.body),
    );
    return reply.status(201).send(result);
  });
};
