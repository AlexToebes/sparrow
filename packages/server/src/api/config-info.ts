import type { FastifyPluginAsync } from 'fastify';
import type { AppDb } from '../db/client.js';

/** GET /api/config: read-only effective settings for the Settings page. Never includes secrets or URLs. */
export const configInfoRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app) => {
  app.get('/api/config', async () => ({
    provider: app.provider.id,
    pollIntervalMinutes: app.pollIntervalMinutes,
    staleAfterHours: app.staleAfterHours,
    dataDir: app.dataDir,
    backupDir: app.backupDir,
  }));
};
