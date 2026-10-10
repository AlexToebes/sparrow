import { existsSync } from 'node:fs';
import path from 'node:path';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

/** True for /api and /api/... (never served by the web fallback). */
const isApiPath = (pathname: string) => /^\/api(\/|$)/.test(pathname);

/** A last path segment with a dot looks like a file ("/assets/x.js"), not a client route. */
const looksLikeFile = (pathname: string) => path.posix.basename(pathname).includes('.');

/**
 * True when an unmatched request is a client-side route that index.html should answer
 * (GET or HEAD, outside /api, not a file-looking path such as a missing /assets/x.js).
 */
export function isClientRoute(method: string, url: string): boolean {
  if (method !== 'GET' && method !== 'HEAD') return false;
  const pathname = url.split('?')[0] ?? '';
  return !isApiPath(pathname) && !looksLikeFile(pathname);
}

/**
 * R16: serves the built web bundle from `webDistDir`. Returns true when the bundle exists and
 * was registered. If it is missing the API still works and a warning is logged.
 * Client-route fallback to index.html is done by the app's not-found handler (see isClientRoute),
 * so unknown /api/* keeps the JSON 404.
 */
export function registerWebBundle(app: FastifyInstance, webDistDir: string): boolean {
  const root = path.resolve(webDistDir);
  if (!existsSync(path.join(root, 'index.html'))) {
    app.log.warn(`Web bundle not found at ${root}; serving the API only (set WEB_DIST_DIR).`);
    return false;
  }
  void app.register(fastifyStatic, {
    root,
    // Vite fingerprints everything under /assets, so it can be cached for good.
    setHeaders(reply, filePath) {
      const top = path.relative(root, filePath).split(path.sep)[0];
      reply.header(
        'Cache-Control',
        top === 'assets' ? 'public, max-age=31536000, immutable' : 'no-cache',
      );
    },
  });
  return true;
}
