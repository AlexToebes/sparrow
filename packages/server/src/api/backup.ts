import type { FastifyPluginAsync } from 'fastify';
import { exportData, importData } from '../core/backup.js';
import type { AppDb } from '../db/client.js';

/** R43: a full export is well above Fastify's 1 MB default body limit. */
export const IMPORT_BODY_LIMIT_BYTES = 50 * 1024 * 1024;

/** Export and import routes (R41, R43, R44). Errors map in app.ts (invalid -> 400). */
export const backupRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, opts) => {
  app.get('/api/export', async (_req, reply) => {
    const data = exportData(opts.db);
    reply.header(
      'Content-Disposition',
      `attachment; filename="sparrow-export-${data.exportedAt.slice(0, 10)}.json"`,
    );
    return data;
  });

  app.post('/api/import', { bodyLimit: IMPORT_BODY_LIMIT_BYTES }, async (req) =>
    importData(opts.db, req.body, { backupDir: app.backupDir }),
  );
};
