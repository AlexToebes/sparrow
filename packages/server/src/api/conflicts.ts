import type { FastifyPluginAsync } from 'fastify';
import { addConflict, listDriveConflicts, removeConflict } from '../core/conflicts.js';
import type { AppDb } from '../db/client.js';

/** R78: drives that are not recommended together. Thin: parse, call the service, return. */
export const conflictRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, opts) => {
  const { db } = opts;

  // The pairs a drive is in, seen from that drive.
  app.get<{ Params: { id: string } }>('/api/drives/:id/conflicts', async (req) =>
    listDriveConflicts(db, req.params.id),
  );

  // Marks the pair (400 for the drive itself, 404 for an unknown drive, 409 for an existing pair).
  app.post<{ Params: { id: string } }>('/api/drives/:id/conflicts', async (req, reply) => {
    const view = addConflict(db, req.params.id, req.body);
    return reply.status(201).send(view);
  });

  // Takes the pair apart (404 when the two are not marked).
  app.delete<{ Params: { id: string; otherId: string } }>(
    '/api/drives/:id/conflicts/:otherId',
    async (req, reply) => {
      removeConflict(db, req.params.id, req.params.otherId);
      return reply.status(204).send();
    },
  );
};
