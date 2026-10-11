import type { FastifyPluginAsync } from 'fastify';
import type { AppDb } from '../db/client.js';
import { backupRoutes } from './backup.js';
import { configInfoRoutes } from './config-info.js';
import { assignmentRoutes } from './assignment.js';
import { driveRoutes } from './drives.js';
import { inboxRoutes } from './inbox.js';
import { layoutRoutes } from './layout.js';
import { poolRoutes } from './pools.js';
import { providerStatusRoutes } from './provider-status.js';
import { statusRoutes } from './status.js';
import { suggestionRoutes } from './suggestions.js';

/**
 * Route modules registered by buildApp, each receiving `{ db }`.
 * Each backend step appends its module here (one line per step) so that
 * parallel steps only touch this array and their own files.
 */
export const routeModules: FastifyPluginAsync<{ db: AppDb }>[] = [
  // Step 2: layout routes
  layoutRoutes,
  // Step 3: drive and event routes
  driveRoutes,
  // Step 4: provider status and snapshot routes
  providerStatusRoutes,
  // Step 6: discovery inbox routes
  inboxRoutes,
  // Step 7: slot assignment and retirement routes
  assignmentRoutes,
  // Step 9: pool and membership routes
  poolRoutes,
  // Step 8: stale and missing status route
  statusRoutes,
  // Step 10: export and import routes
  backupRoutes,
  // Step 14: read-only effective config
  configInfoRoutes,
  // Post-MVP 5: suggested updates from provider observations (R72)
  suggestionRoutes,
];
