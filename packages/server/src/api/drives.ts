import type { FastifyPluginAsync } from 'fastify';
import {
  createDriveInputSchema,
  listDrivesQuerySchema,
  recentActivitiesQuerySchema,
  updateDriveInputSchema,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import { createDrive, getDrive, listDrives, updateDrive } from '../core/drives.js';
import { listDriveActivities, listRecentActivities } from '../core/activities.js';

/** Drive routes (R3, R14, D5). Thin: parse, call the service, return. There is no DELETE route. */
export const driveRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, opts) => {
  const { db } = opts;

  app.get('/api/drives', async (req) => {
    const query = listDrivesQuerySchema.parse(req.query);
    return listDrives(db, query);
  });

  app.post('/api/drives', async (req, reply) => {
    const drive = createDrive(db, createDriveInputSchema.parse(req.body));
    return reply.status(201).send(drive);
  });

  app.get<{ Params: { id: string } }>('/api/drives/:id', async (req) =>
    getDrive(db, req.params.id),
  );

  app.patch<{ Params: { id: string } }>('/api/drives/:id', async (req) =>
    updateDrive(db, req.params.id, updateDriveInputSchema.parse(req.body)),
  );

  // R75: the latest activities of all kinds (drive and non-drive), newest first, each with its events.
  app.get('/api/activities/recent', async (req) => {
    const { limit, before } = recentActivitiesQuerySchema.parse(req.query);
    return listRecentActivities(db, limit, before);
  });

  // R14: the activities that have an event for the drive, each with ALL its events, newest first.
  app.get<{ Params: { id: string } }>('/api/drives/:id/history', async (req) => {
    getDrive(db, req.params.id); // 404 for an unknown drive
    return listDriveActivities(db, req.params.id);
  });
};
