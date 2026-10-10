import type { FastifyPluginAsync } from 'fastify';
import type { AppDb } from '../db/client.js';
import { assignmentRoutes } from './assignment.js';
import { driveRoutes } from './drives.js';
import { layoutRoutes } from './layout.js';
import { providerStatusRoutes } from './provider-status.js';

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
  // Step 7: slot assignment and retirement routes
  assignmentRoutes,
  // Step 9: pool routes
];
