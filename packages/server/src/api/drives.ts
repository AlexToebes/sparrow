import type { FastifyPluginAsync } from 'fastify';
import { listDrivesQuerySchema } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { createDrive, getDrive, listDrives, updateDrive } from '../core/drives.js';
import { listDriveEvents } from '../core/events.js';

/** Drive routes (R3, R14, D5). Thin: parse, call the service, return. There is no DELETE route. */
export const driveRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, opts) => {
  const { db } = opts;

  app.get('/api/drives', async (req) => {
    const query = listDrivesQuerySchema.parse(req.query);
    return listDrives(db, query);
  });

  app.post('/api/drives', async (req, reply) => {
    const drive = createDrive(db, req.body);
    return reply.status(201).send(drive);
  });

  app.get<{ Params: { id: string } }>('/api/drives/:id', async (req) =>
    getDrive(db, req.params.id),
  );

  app.patch<{ Params: { id: string } }>('/api/drives/:id', async (req) =>
    updateDrive(db, req.params.id, req.body),
  );

  app.get<{ Params: { id: string } }>('/api/drives/:id/events', async (req) => {
    getDrive(db, req.params.id); // 404 for an unknown drive
    return listDriveEvents(db, req.params.id);
  });
};
