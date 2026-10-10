import type { Observation } from '@sparrow/shared';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { createPoller } from '../src/core/poller.js';
import type { DriveDataProvider } from '../src/core/provider-port.js';
import { openDatabase } from '../src/db/client.js';
import { createRepositories } from '../src/db/repositories.js';

const obs = (serial: string): Observation => ({
  serial,
  health: 'ok',
  lastReportedAt: '2026-01-01T00:00:00.000Z',
  state: 'active',
});

function fake(id: string, impl: () => Promise<unknown>): DriveDataProvider {
  return {
    id,
    capabilities: { drives: true, pools: false },
    expectedUpdateIntervalHours: 1,
    fetchSnapshot: impl as () => Promise<Observation[]>,
    checkConnection: async () => ({ ok: true }),
  };
}

const clock = (iso: string) => () => new Date(iso);

describe('poller', () => {
  it('stores observations on success', async () => {
    const { db } = openDatabase(':memory:');
    const p = createPoller({
      db,
      provider: fake('fake', async () => [obs('A')]),
      intervalMs: 1000,
      now: clock('2026-02-01T00:00:00.000Z'),
    });
    expect(await p.pollOnce()).toEqual({ ok: true, observationCount: 1 });
    expect(createRepositories(db).snapshot.get()).toMatchObject({
      providerId: 'fake',
      lastSuccessAt: '2026-02-01T00:00:00.000Z',
      lastAttemptAt: '2026-02-01T00:00:00.000Z',
      lastError: null,
      observations: [obs('A')],
    });
  });

  it('keeps the last snapshot on failure and records the error', async () => {
    const { db } = openDatabase(':memory:');
    let fail = false;
    let t = '2026-02-01T00:00:00.000Z';
    const p = createPoller({
      db,
      provider: fake('fake', async () => {
        if (fail) throw new Error('boom');
        return [obs('A')];
      }),
      intervalMs: 1000,
      now: () => new Date(t),
    });
    await p.pollOnce();
    fail = true;
    t = '2026-02-01T01:00:00.000Z';
    expect(await p.pollOnce()).toEqual({ ok: false, error: 'boom' });
    expect(createRepositories(db).snapshot.get()).toMatchObject({
      observations: [obs('A')],
      lastSuccessAt: '2026-02-01T00:00:00.000Z',
      lastAttemptAt: '2026-02-01T01:00:00.000Z',
      lastError: 'boom',
    });
  });

  it('treats invalid data and synchronous throws as failures', async () => {
    const { db } = openDatabase(':memory:');
    const bad = createPoller({
      db,
      provider: fake('fake', async () => [{ nope: 1 }]),
      intervalMs: 1000,
    });
    expect((await bad.pollOnce()).ok).toBe(false);
    const sync = createPoller({
      db,
      provider: fake('fake', () => {
        throw new Error('sync');
      }),
      intervalMs: 1000,
    });
    expect(await sync.pollOnce()).toEqual({ ok: false, error: 'sync' });
    expect(createRepositories(db).snapshot.get()?.observations).toEqual([]);
  });

  it('clears the cache when the provider changes', async () => {
    const { db } = openDatabase(':memory:');
    await createPoller({
      db,
      provider: fake('one', async () => [obs('A')]),
      intervalMs: 1000,
    }).pollOnce();
    const p2 = createPoller({
      db,
      provider: fake('two', async () => {
        throw new Error('down');
      }),
      intervalMs: 1000,
    });
    await p2.pollOnce();
    expect(createRepositories(db).snapshot.get()).toMatchObject({
      providerId: 'two',
      observations: [],
      lastSuccessAt: null,
    });
  });

  it('polls immediately on start and then on the interval; stop halts it', async () => {
    vi.useFakeTimers();
    try {
      const { db } = openDatabase(':memory:');
      const fetchSnapshot = vi.fn(async () => [] as Observation[]);
      const p = createPoller({ db, provider: fake('f', fetchSnapshot), intervalMs: 1000 });
      p.start();
      expect(fetchSnapshot).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(2000);
      expect(fetchSnapshot).toHaveBeenCalledTimes(3);
      p.stop();
      await vi.advanceTimersByTimeAsync(5000);
      expect(fetchSnapshot).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('corrupt snapshot row (R18, R55)', () => {
  const corrupt = (sqlite: { exec(sql: string): unknown }, providerId = 'fake') =>
    sqlite.exec(
      `INSERT OR REPLACE INTO provider_snapshot (id, provider_id, observations) VALUES (1, '${providerId}', '[{"bad":true}]')`,
    );

  it('snapshot.get() treats an unparseable row as no snapshot instead of throwing', () => {
    const { db, sqlite } = openDatabase(':memory:');
    corrupt(sqlite);
    expect(createRepositories(db).snapshot.get()).toBeNull();
  });

  it('the next successful poll overwrites a corrupt row, even one from another provider', async () => {
    const { db, sqlite } = openDatabase(':memory:');
    corrupt(sqlite, 'old-provider');
    const p = createPoller({
      db,
      provider: fake('fake', async () => [obs('A')]),
      intervalMs: 1000,
    });
    expect(await p.pollOnce()).toEqual({ ok: true, observationCount: 1 });
    expect(createRepositories(db).snapshot.get()).toMatchObject({
      providerId: 'fake',
      observations: [obs('A')],
      lastError: null,
    });
  });

  it('a failing poll over a corrupt row records the error and logs it', async () => {
    const { db, sqlite } = openDatabase(':memory:');
    corrupt(sqlite);
    const log = { warn: vi.fn() };
    const p = createPoller({
      db,
      provider: fake('fake', async () => {
        throw new Error('down');
      }),
      intervalMs: 1000,
      log,
    });
    expect(await p.pollOnce()).toEqual({ ok: false, error: 'down' });
    expect(createRepositories(db).snapshot.get()).toMatchObject({ lastError: 'down' });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('a failure while discarding a foreign cache is a failed poll, not a thrown one', async () => {
    const { db, sqlite } = openDatabase(':memory:');
    createRepositories(db).snapshot.put({ providerId: 'other', observations: [] });
    sqlite.exec(
      "CREATE TRIGGER no_delete BEFORE DELETE ON provider_snapshot BEGIN SELECT RAISE(ABORT, 'locked'); END",
    );
    const log = { warn: vi.fn() };
    const p = createPoller({
      db,
      provider: fake('fake', async () => [obs('A')]),
      intervalMs: 1000,
      log,
    });
    const result = await p.pollOnce();
    expect(result.ok).toBe(false);
    expect(log.warn).toHaveBeenCalled();
  });
});

describe('GET /api/provider/status', () => {
  it('reports before any poll, after success and after failure', async () => {
    const { db } = openDatabase(':memory:');
    let fail = false;
    const provider = fake('fake', async () => {
      if (fail) throw new Error('boom');
      return [obs('A'), obs('B')];
    });
    const app = buildApp({ db, provider });
    const get = async () => (await app.inject('/api/provider/status')).json();

    expect(await get()).toMatchObject({
      providerId: 'fake',
      capabilities: { drives: true, pools: false },
      reachable: false,
      lastSuccessAt: null,
      observationCount: 0,
    });

    const poller = createPoller({ db, provider, intervalMs: 1000 });
    await poller.pollOnce();
    expect(await get()).toMatchObject({ reachable: true, lastError: null, observationCount: 2 });

    fail = true;
    await poller.pollOnce();
    const s = await get();
    expect(s).toMatchObject({ reachable: false, lastError: 'boom', observationCount: 2 });
    expect(s.lastSuccessAt).not.toBeNull();
  });

  it('works with buildApp({ db }) defaulting to none', async () => {
    const { db } = openDatabase(':memory:');
    const res = await buildApp({ db }).inject('/api/provider/status');
    expect(res.json().providerId).toBe('none');
  });
});
