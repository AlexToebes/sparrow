import { observationSchema, type Observation } from '@sparrow/shared';
import { z } from 'zod';
import type { AppDb } from '../db/client.js';
import { createRepositories } from '../db/repositories.js';
import { recordHealthChanges } from './health-history.js';
import type { DriveDataProvider } from './provider-port.js';
import { errorReason, safeUrlForLog } from './safe-url.js';

/** The slice of a logger the poller uses (the Fastify logger fits). */
export interface PollLog {
  warn(obj: object, msg: string): void;
}

export interface PollerOptions {
  db: AppDb;
  /** Where poll failures are reported. Optional; failures are always stored in the snapshot too. */
  log?: PollLog | undefined;
  provider: DriveDataProvider;
  intervalMs: number;
  now?: () => Date;
}

export type PollResult = { ok: true; observationCount: number } | { ok: false; error: string };

export interface Poller {
  pollOnce(): Promise<PollResult>;
  start(): void;
  stop(): void;
}

const observationsSchema = z.array(observationSchema);

export function createPoller(opts: PollerOptions): Poller {
  const { db, provider, intervalMs, log } = opts;
  const now = opts.now ?? (() => new Date());
  const repos = createRepositories(db);
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<PollResult> | undefined;

  // R55: a cache written by a different provider is never shown.
  const discardForeignCache = () => {
    const cached = repos.snapshot.get();
    if (cached && cached.providerId !== provider.id) repos.snapshot.clear();
  };

  const run = async (): Promise<PollResult> => {
    const at = now().toISOString();
    let observations: Observation[];
    try {
      discardForeignCache();
      observations = observationsSchema.parse(await provider.fetchSnapshot());
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      // The log says where the poll went (no credentials) and why it failed.
      const url = safeUrlForLog(provider.endpoint);
      log?.warn(
        { err, providerId: provider.id, ...(url ? { url } : {}) },
        `Poll of provider "${provider.id}"${url ? ` at ${url}` : ''} failed: ${errorReason(err)}`,
      );
      // R18: keep the previous observations and lastSuccessAt; the snapshot goes stale, not empty.
      const prev = repos.snapshot.get();
      repos.snapshot.put({
        providerId: provider.id,
        observations: prev?.observations ?? [],
        lastSuccessAt: prev?.lastSuccessAt ?? null,
        lastAttemptAt: at,
        lastError: error,
      });
      return { ok: false, error };
    }
    repos.snapshot.put({
      providerId: provider.id,
      observations,
      lastSuccessAt: at,
      lastAttemptAt: at,
      lastError: null,
    });
    try {
      // R20: only after a successful poll of the active provider; never fails the poll.
      recordHealthChanges(db, observations, at);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log?.warn({ err, providerId: provider.id }, `Could not record health changes: ${error}`);
    }
    return { ok: true, observationCount: observations.length };
  };

  const pollOnce = (): Promise<PollResult> => {
    // Overlapping polls share one in-flight run.
    running ??= run()
      .catch((err: unknown): PollResult => {
        const error = err instanceof Error ? err.message : String(err);
        log?.warn({ err, providerId: provider.id }, `Poll could not store its result: ${error}`);
        return { ok: false, error };
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  return {
    pollOnce,
    start() {
      if (timer) return;
      timer = setInterval(() => void pollOnce(), intervalMs);
      timer.unref();
      void pollOnce();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
