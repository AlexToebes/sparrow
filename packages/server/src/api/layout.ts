import type { FastifyPluginAsync } from 'fastify';
import {
  createEnclosureSchema,
  createGridSchema,
  updateGridSchema,
  updateSlotSchema,
} from '@sparrow/shared';
import { createLayoutService } from '../core/layout.js';
import type { AppDb } from '../db/client.js';

interface IdParams {
  id: string;
}

/** Layout routes (R38). Bodies are validated with the shared zod schemas; errors map in app.ts. */
export const layoutRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, opts) => {
  const layout = createLayoutService(opts.db);

  app.get('/api/layout', async () => layout.getLayout());

  app.post('/api/enclosures', async (req, reply) =>
    reply.status(201).send(layout.createEnclosure(createEnclosureSchema.parse(req.body))),
  );

  app.patch<{ Params: IdParams }>('/api/enclosures/:id', async (req) =>
    layout.renameEnclosure(req.params.id, createEnclosureSchema.parse(req.body)),
  );

  app.delete<{ Params: IdParams }>('/api/enclosures/:id', async (req, reply) => {
    layout.deleteEnclosure(req.params.id);
    return reply.status(204).send();
  });

  app.post<{ Params: IdParams }>('/api/enclosures/:id/grids', async (req, reply) =>
    reply.status(201).send(layout.createGrid(req.params.id, createGridSchema.parse(req.body))),
  );

  app.patch<{ Params: IdParams }>('/api/grids/:id', async (req) =>
    layout.updateGrid(req.params.id, updateGridSchema.parse(req.body)),
  );

  app.delete<{ Params: IdParams }>('/api/grids/:id', async (req, reply) => {
    layout.deleteGrid(req.params.id);
    return reply.status(204).send();
  });

  app.patch<{ Params: IdParams }>('/api/slots/:id', async (req) =>
    layout.updateSlotLabel(req.params.id, updateSlotSchema.parse(req.body)),
  );
};
