import type { FastifyPluginAsync } from 'fastify';
import { applySuggestionsInputSchema } from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import {
  applySuggestions,
  getDriveSuggestions,
  getSuggestionSummary,
} from '../core/suggestions.js';

/** Suggested updates (R72). Thin: parse, call, return. Reads never change anything. */
export const suggestionRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, opts) => {
  const { db } = opts;

  app.get('/api/suggestions', async () => getSuggestionSummary(db, app.provider.id));

  app.get<{ Params: { id: string } }>('/api/drives/:id/suggestions', async (req) => ({
    suggestions: getDriveSuggestions(db, app.provider.id, req.params.id),
  }));

  app.post<{ Params: { id: string } }>('/api/drives/:id/suggestions/apply', async (req) =>
    applySuggestions(
      db,
      app.provider.id,
      req.params.id,
      applySuggestionsInputSchema.parse(req.body).fields,
    ),
  );
};
