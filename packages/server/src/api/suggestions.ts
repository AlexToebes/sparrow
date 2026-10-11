import type { FastifyPluginAsync } from 'fastify';
import {
  applySuggestionsInputSchema,
  dismissSuggestionsInputSchema,
  undismissSuggestionsInputSchema,
} from '@sparrow/shared';
import type { AppDb } from '../db/client.js';
import {
  applySuggestions,
  dismissSuggestions,
  getDriveSuggestionLists,
  undismissSuggestions,
  getSuggestionSummary,
} from '../core/suggestions.js';

/** Suggested updates (R72). Thin: parse, call, return. Reads never change anything. */
export const suggestionRoutes: FastifyPluginAsync<{ db: AppDb }> = async (app, opts) => {
  const { db } = opts;

  app.get('/api/suggestions', async () => getSuggestionSummary(db, app.provider.id));

  app.get<{ Params: { id: string } }>('/api/drives/:id/suggestions', async (req) => {
    const { active, dismissed } = getDriveSuggestionLists(db, app.provider.id, req.params.id);
    return { suggestions: active, dismissed };
  });

  app.post<{ Params: { id: string } }>('/api/drives/:id/suggestions/apply', async (req) =>
    applySuggestions(
      db,
      app.provider.id,
      req.params.id,
      applySuggestionsInputSchema.parse(req.body).fields,
    ),
  );

  // Dismissals are reversible, so they need no confirmation; both answer 204.
  app.post<{ Params: { id: string } }>(
    '/api/drives/:id/suggestions/dismiss',
    async (req, reply) => {
      dismissSuggestions(
        db,
        app.provider.id,
        req.params.id,
        dismissSuggestionsInputSchema.parse(req.body).fields,
      );
      return reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    '/api/drives/:id/suggestions/undismiss',
    async (req, reply) => {
      undismissSuggestions(
        db,
        app.provider.id,
        req.params.id,
        undismissSuggestionsInputSchema.parse(req.body).fields,
      );
      return reply.status(204).send();
    },
  );
};
