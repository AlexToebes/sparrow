import type { FastifyPluginAsync } from 'fastify';
import {
  assignDriveInputSchema,
  moveDriveInputSchema,
  noteInputSchema,
  removeDriveInputSchema,
  retireDriveInputSchema,
  rmaInputSchema,
} from '@sparrow/shared';
import {
  assignDrive,
  getAssignmentDefaults,
  reinstateDrive,
  removeToSpares,
  retireDrive,
  sendForRma,
} from '../core/assignment.js';
import { moveDrive } from '../core/move.js';
import type { AppDb } from '../db/client.js';

interface IdParams {
  id: string;
}

/** Slot assignment and retirement routes (R8, R35, R37, R60, R61, R62). Thin: parse, call, return. */
export const assignmentRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, opts) => {
  const { db } = opts;

  app.post<{ Params: IdParams }>('/api/slots/:id/assign', async (req) =>
    assignDrive(db, { ...assignDriveInputSchema.parse(req.body), slotId: req.params.id }),
  );

  app.get<{ Params: IdParams }>('/api/slots/:id/assignment-defaults', async (req) =>
    getAssignmentDefaults(db, req.params.id),
  );

  app.post<{ Params: IdParams }>('/api/drives/:id/remove', async (req) =>
    removeToSpares(db, req.params.id, removeDriveInputSchema.parse(req.body ?? {})),
  );

  // R73: one Move for an installed drive.
  app.post<{ Params: IdParams }>('/api/drives/:id/move', async (req) =>
    moveDrive(db, req.params.id, moveDriveInputSchema.parse(req.body)),
  );

  app.post<{ Params: IdParams }>('/api/drives/:id/retire', async (req) =>
    retireDrive(db, req.params.id, retireDriveInputSchema.parse(req.body)),
  );

  app.post<{ Params: IdParams }>('/api/drives/:id/rma', async (req) =>
    sendForRma(db, req.params.id, rmaInputSchema.parse(req.body ?? {})),
  );

  app.post<{ Params: IdParams }>('/api/drives/:id/reinstate', async (req) =>
    reinstateDrive(db, req.params.id, noteInputSchema.parse(req.body ?? {})),
  );
};
