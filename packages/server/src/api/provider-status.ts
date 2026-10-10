import type { FastifyPluginAsync } from 'fastify';
import { createRepositories } from '../db/repositories.js';
import type { AppDb } from '../db/client.js';

/** GET /api/provider/status (R19, R56). Reads the cached snapshot row plus provider metadata. */
export const providerStatusRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, { db }) => {
  const repos = createRepositories(db);
  app.get('/api/provider/status', async () => {
    const provider = app.provider;
    const row = repos.snapshot.get();
    const mine = row && row.providerId === provider.id ? row : null;
    return {
      providerId: provider.id,
      capabilities: provider.capabilities,
      reachable: mine !== null && mine.lastError === null && mine.lastAttemptAt !== null,
      lastSuccessAt: mine?.lastSuccessAt ?? null,
      lastAttemptAt: mine?.lastAttemptAt ?? null,
      lastError: mine?.lastError ?? null,
      observationCount: mine?.observations.length ?? 0,
    };
  });
};
