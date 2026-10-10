import { observationSchema, type Observation } from '@sparrow/shared';
import { z } from 'zod';
import type { AppDb } from '../db/client.js';
import { createRepositories } from '../db/repositories.js';
import type { DriveDataProvider } from './provider-port.js';

export interface PollerOptions {
  db: AppDb;
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
  const { db, provider, intervalMs } = opts;
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
    discardForeignCache();
    const at = now().toISOString();
    let observations: Observation[];
    try {
      observations = observationsSchema.parse(await provider.fetchSnapshot());
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
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
    return { ok: true, observationCount: observations.length };
  };

  const pollOnce = (): Promise<PollResult> => {
    // Overlapping polls share one in-flight run.
    running ??= run()
      .catch((err: unknown): PollResult => ({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }))
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
