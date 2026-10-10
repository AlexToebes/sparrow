import path from 'node:path';
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply } from 'fastify';
import { ZodError } from 'zod';
import { DomainError } from '../core/errors.js';
import { defaultStaleAfterHours } from '../core/health-status.js';
import type { DriveDataProvider } from '../core/provider-port.js';
import type { AppDb } from '../db/client.js';
import { noProvider } from './no-provider.js';
import { routeModules } from './routes.js';
import { isClientRoute, registerWebBundle } from './static.js';

export interface AppDeps {
  db: AppDb;
  /** Active provider (defaults to the none adapter); used by the status route. */
  provider?: DriveDataProvider;
  /** R28: stale threshold in hours. Defaults to 1.5 x the provider's update interval. */
  staleAfterHours?: number | undefined;
  /** R44: directory for the automatic pre-import backup. Defaults to `$DATA_DIR/exports`. */
  backupDir?: string | undefined;
  /** Turns on Fastify's request and error logging (main.ts does; tests leave it off). */
  logger?: boolean | undefined;
  /** Shown read-only by GET /api/config. */
  pollIntervalMinutes?: number | undefined;
  dataDir?: string | undefined;
  /** R16: built web bundle to serve (index.html fallback for client routes). Unset = API only. */
  webDistDir?: string | undefined;
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
  const app = Fastify({ logger: deps.logger ?? false });
  app.decorate('db', deps.db);
  app.decorate('provider', deps.provider ?? noProvider);
  app.decorate('staleAfterHours', deps.staleAfterHours ?? defaultStaleAfterHours(app.provider));
  app.decorate('pollIntervalMinutes', deps.pollIntervalMinutes ?? 5);
  app.decorate('dataDir', deps.dataDir ?? process.env.DATA_DIR ?? '/data');
  app.decorate(
    'backupDir',
    deps.backupDir ?? path.join(process.env.DATA_DIR ?? '/data', 'exports'),
  );

  // An empty body with a JSON content type (a bodyless POST from fetch, curl -H) is {}, not a 400.
  const parseJson = app.getDefaultJsonParser('error', 'error');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (req, body, done) => {
    if (typeof body === 'string' && body.trim() === '') return done(null, {});
    parseJson(req, body as string, done);
  });

  const webEnabled = deps.webDistDir ? registerWebBundle(app, deps.webDistDir) : false;

  app.setNotFoundHandler((req, reply) => {
    if (webEnabled && isClientRoute(req.method, req.url)) return reply.sendFile('index.html');
    return sendError(
      reply,
      404,
      'not-found',
      `Route ${req.method} ${req.url.split('?')[0]} not found`,
    );
  });

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
    pollIntervalMinutes: number;
    dataDir: string;
  }
}
