import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';

let opened: OpenedDatabase;
let repo: Repositories;

beforeEach(() => {
  opened = openDatabase(':memory:');
  repo = createRepositories(opened.db);
});
afterEach(() => opened.sqlite.close());

const observation = {
  serial: 'ABC123',
  health: 'ok' as const,
  lastReportedAt: '2026-10-09T12:00:00.000Z',
  state: 'active' as const,
};

describe('app_meta (Step 2 one-time flags)', () => {
  it('returns null for an unknown key, then the stored value', () => {
    expect(repo.meta.get('layout-seeded')).toBeNull();
    repo.meta.set('layout-seeded', '1');
    expect(repo.meta.get('layout-seeded')).toBe('1');
  });

  it('set overwrites an existing key without creating a duplicate', () => {
    repo.meta.set('k', 'a');
    repo.meta.set('k', 'b');
    expect(repo.meta.get('k')).toBe('b');
    const count = opened.sqlite.prepare('SELECT count(*) AS c FROM app_meta').get() as {
      c: number;
    };
    expect(count.c).toBe(1);
  });
});

describe('provider_snapshot (Step 4, R18, R55)', () => {
  it('get returns null when empty', () => {
    expect(repo.snapshot.get()).toBeNull();
  });

  it('put then get returns the parsed observations and timestamps', () => {
    repo.snapshot.put({
      providerId: 'scrutiny',
      observations: [observation],
      lastSuccessAt: '2026-10-09T12:00:00.000Z',
      lastAttemptAt: '2026-10-09T12:00:00.000Z',
      lastError: null,
    });
    expect(repo.snapshot.get()).toEqual({
      providerId: 'scrutiny',
      observations: [observation],
      lastSuccessAt: '2026-10-09T12:00:00.000Z',
      lastAttemptAt: '2026-10-09T12:00:00.000Z',
      lastError: null,
    });
  });

  it('put is an upsert on the single row and keeps the last good data when a later attempt fails', () => {
    repo.snapshot.put({
      providerId: 'scrutiny',
      observations: [observation],
      lastSuccessAt: '2026-10-09T12:00:00.000Z',
      lastAttemptAt: '2026-10-09T12:00:00.000Z',
    });
    repo.snapshot.put({
      providerId: 'scrutiny',
      observations: [observation],
      lastSuccessAt: '2026-10-09T12:00:00.000Z',
      lastAttemptAt: '2026-10-10T12:00:00.000Z',
      lastError: 'connection refused',
    });
    const row = repo.snapshot.get();
    expect(row?.lastAttemptAt).toBe('2026-10-10T12:00:00.000Z');
    expect(row?.lastSuccessAt).toBe('2026-10-09T12:00:00.000Z');
    expect(row?.lastError).toBe('connection refused');
    expect(row?.observations).toHaveLength(1);
    const count = opened.sqlite.prepare('SELECT count(*) AS c FROM provider_snapshot').get() as {
      c: number;
    };
    expect(count.c).toBe(1);
  });

  it('R55: rejects a second row and any id other than 1 at the database level', () => {
    expect(() =>
      opened.sqlite
        .prepare(
          "INSERT INTO provider_snapshot (id, provider_id, observations) VALUES (2, 'x', '[]')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('rejects invalid observations before writing', () => {
    expect(() =>
      repo.snapshot.put({
        providerId: 'scrutiny',
        observations: [{ health: 'great', lastReportedAt: 'nope', state: 'active' } as never],
      }),
    ).toThrow();
    expect(repo.snapshot.get()).toBeNull();
  });

  it('clear removes the row; get is null afterwards', () => {
    repo.snapshot.put({ providerId: 'none', observations: [] });
    repo.snapshot.clear();
    expect(repo.snapshot.get()).toBeNull();
    expect(() => repo.snapshot.clear()).not.toThrow();
  });
});
