import path from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { DomainError } from '../core/errors.js';
import { defaultStaleAfterHours } from '../core/health-status.js';
import type { DriveDataProvider } from '../core/provider-port.js';
import type { AppDb } from '../db/client.js';
import { createNoneProvider } from '../providers/none/index.js';
import { routeModules } from './routes.js';

export interface AppDeps {
  db: AppDb;
  /** Active provider (defaults to the none adapter); used by the status route. */
  provider?: DriveDataProvider;
  /** R28: stale threshold in hours. Defaults to 1.5 x the provider's update interval. */
  staleAfterHours?: number | undefined;
  /** R44: directory for the automatic pre-import backup. Defaults to `$DATA_DIR/exports`. */
  backupDir?: string | undefined;
}

export interface ErrorBody {
  error: { code: string; message: string; details?: unknown };
}

const sendError = (
  reply: FastifyReply,
  status: number,
  code: string,
  message: string,
  details?: unknown,
) => {
  const body: ErrorBody = { error: { code, message } };
  if (details !== undefined) body.error.details = details;
  return reply.status(status).send(body);
};

const DOMAIN_STATUS = { 'not-found': 404, conflict: 409, invalid: 400 } as const;

export function buildApp(deps: AppDeps): FastifyInstance {
  const app = Fastify();
  app.decorate('db', deps.db);
  app.decorate('provider', deps.provider ?? createNoneProvider());
  app.decorate('staleAfterHours', deps.staleAfterHours ?? defaultStaleAfterHours(app.provider));
  app.decorate(
    'backupDir',
    deps.backupDir ?? path.join(process.env.DATA_DIR ?? '/data', 'exports'),
  );

  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof DomainError) {
      return sendError(reply, DOMAIN_STATUS[err.code], err.code, err.message, err.details);
    }
    if (err instanceof ZodError) {
      return sendError(reply, 400, 'invalid', 'Validation failed', err.issues);
    }
    // Client errors raised by Fastify itself (for example malformed JSON) are 400s, not server faults.
    const statusCode = (err as FastifyError).statusCode;
    if (typeof statusCode === 'number' && statusCode >= 400 && statusCode < 500) {
      return sendError(reply, statusCode, 'invalid', err.message);
    }
    app.log.error(err);
    return sendError(reply, 500, 'internal', 'Internal server error');
  });

  // R67: liveness only. Must never touch a provider.
  app.get('/api/health', async () => ({ status: 'ok' }));

  for (const register of routeModules) {
    app.register(register, { db: deps.db });
  }

  return app;
}

declare module 'fastify' {
  interface FastifyInstance {
    db: AppDb;
    provider: DriveDataProvider;
    staleAfterHours: number;
    backupDir: string;
  }
}
