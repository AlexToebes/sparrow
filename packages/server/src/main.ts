import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from './api/app.js';
import { loadConfig } from './config.js';
import { openDatabase } from './db/client.js';

export const SERVICE_NAME = 'sparrow-server';

export async function start(env: Record<string, string | undefined> = process.env) {
  const config = loadConfig(env);
  mkdirSync(config.DATA_DIR, { recursive: true });
  const { db } = openDatabase(path.join(config.DATA_DIR, 'app.db'));
  const app = buildApp({ db });
  await app.listen({ port: config.PORT, host: config.HOST });
  return app;
}

// Only start when run as the entrypoint, so importing this module in tests has no side effects.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  start().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
