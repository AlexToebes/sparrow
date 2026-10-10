import type { FastifyPluginAsync } from 'fastify';
import {
  changeMembershipInputSchema,
  createPoolInputSchema,
  joinPoolInputSchema,
  leavePoolInputSchema,
  updatePoolInputSchema,
} from '@sparrow/shared';
import { changeMembership, joinPool, leavePool, listMemberships } from '../core/memberships.js';
import { createPool, deletePool, getPool, listPools, updatePool } from '../core/pools.js';
import type { AppDb } from '../db/client.js';

interface IdParams {
  id: string;
}

/** Pool and membership routes (R29, R30, R33, R36). Thin: parse, call the service, return. */
export const poolRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, opts) => {
  const { db } = opts;

  app.get('/api/pools', async () => listPools(db));

  app.post('/api/pools', async (req, reply) => {
    const pool = createPool(db, createPoolInputSchema.parse(req.body));
    return reply.status(201).send(pool);
  });

  app.get<{ Params: IdParams }>('/api/pools/:id', async (req) => getPool(db, req.params.id));

  app.patch<{ Params: IdParams }>('/api/pools/:id', async (req) =>
    updatePool(db, req.params.id, updatePoolInputSchema.parse(req.body)),
  );

  app.delete<{ Params: IdParams }>('/api/pools/:id', async (req, reply) => {
    deletePool(db, req.params.id);
    return reply.status(204).send();
  });

  app.get<{ Params: IdParams }>('/api/drives/:id/memberships', async (req) =>
    listMemberships(db, req.params.id),
  );

  app.post<{ Params: IdParams }>('/api/drives/:id/membership', async (req, reply) => {
    const membership = joinPool(db, req.params.id, joinPoolInputSchema.parse(req.body));
    return reply.status(201).send(membership);
  });

  app.patch<{ Params: IdParams }>('/api/drives/:id/membership', async (req) =>
    changeMembership(db, req.params.id, changeMembershipInputSchema.parse(req.body)),
  );

  // Ends the open membership. This is not a delete: the row stays as history (R29).
  app.delete<{ Params: IdParams }>('/api/drives/:id/membership', async (req) =>
    leavePool(db, req.params.id, leavePoolInputSchema.parse(req.body ?? {})),
  );
};
