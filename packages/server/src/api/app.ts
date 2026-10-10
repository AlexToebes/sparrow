import Fastify, { type FastifyInstance } from 'fastify';
import type { AppDatabase } from '../db/client.js';

export interface AppDeps {
  db: AppDatabase;
}

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify();
  app.decorate('db', deps.db);

  // R67: liveness only. Must never touch a provider.
  app.get('/api/health', async () => ({ status: 'ok' }));

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: AppDatabase;
  }
}
