import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  setupResultSchema,
  setupStateResponseSchema,
  setupInputSchema,
  type SetupInput,
} from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { exportData } from '../src/core/backup.js';
import { DomainError } from '../src/core/errors.js';
import { start } from '../src/main.js';
import { createLayoutService } from '../src/core/layout.js';
import { plain, replay, snapshotState, undoAll } from '../src/core/replay.js';
import { completeSetup, getSetupState, skipSetup } from '../src/core/setup.js';
import {
  IncompatibleDatabaseError,
  openDatabase,
  missingSchemaParts,
  type OpenedDatabase,
} from '../src/db/client.js';
import { activitiesOf, countActivities } from './activity-helpers.js';

// R5 (changed 2026-10-13) and R77: the first-run setup wizard replaces the seed layout.

let opened: OpenedDatabase;
beforeEach(() => {
  opened = openDatabase(':memory:');
});
afterEach(() => opened.sqlite.close());

const input: SetupInput = {
  enclosureName: 'Rack NAS',
  grids: [
    {
      name: 'Front',
      rows: 2,
      columns: 2,
      orientation: 'portrait',
      labels: ['A1', 'A2', '', 'B2'],
    },
    { name: 'Boot', rows: 1, columns: 1, orientation: 'landscape' },
  ],
  pools: [{ name: 'tank', layoutLabel: 'raidz2', expectedMembers: 6 }, { name: 'scratch' }],
};
const parse = (value: unknown) => setupInputSchema.parse(value);

function expectCode(fn: () => unknown, code: string) {
  let caught: unknown;
  try {
    fn();
  } catch (err) {
    caught = err;
  }
  expect(caught).toBeInstanceOf(DomainError);
  expect((caught as DomainError).code).toBe(code);
}

describe('R5/R77: a new install has no layout and needs setup', () => {
  it('R5: a fresh database has no enclosure, no activity and state needed', () => {
    expect(createLayoutService(opened.db).getLayout().enclosures).toEqual([]);
    expect(countActivities(opened.db)).toBe(0);
    expect(getSetupState(opened.db)).toBe('needed');
  });

  it('R77: a database that already has an enclosure counts as set up', () => {
    createLayoutService(opened.db).createEnclosure({ name: 'Mine' });
    expect(getSetupState(opened.db)).toBe('done');
  });
});

describe('R77: completeSetup', () => {
  it('creates the enclosure, grids with slots and labels, and pools, then sets the flag', () => {
    const result = completeSetup(opened.db, parse(input));
    const [enc] = createLayoutService(opened.db).getLayout().enclosures;
    expect(enc!.name).toBe('Rack NAS');
    expect(enc!.id).toBe(result.enclosureId);
    expect(enc!.grids.map((g) => [g.name, g.rows, g.columns, g.orientation])).toEqual([
      ['Front', 2, 2, 'portrait'],
      ['Boot', 1, 1, 'landscape'],
    ]);
    expect(enc!.grids[0]!.slots.map((s) => s.label)).toEqual(['A1', 'A2', null, 'B2']);
    expect(enc!.grids[1]!.slots.map((s) => s.label)).toEqual([null]);
    expect(result.gridIds).toEqual(enc!.grids.map((g) => g.id));
    expect(result.poolIds).toHaveLength(2);
    expect(getSetupState(opened.db)).toBe('done');
  });

  it('R14, R75, R77: writes ONE layout-updated activity with enclosure, grid and pool events', () => {
    const result = completeSetup(opened.db, parse(input));
    const acts = activitiesOf(opened.db);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.kind).toBe('layout-updated');
    expect(acts[0]!.events.map((e) => e.type)).toEqual([
      'enclosure-created',
      'grid-created',
      'grid-created',
      'pool-created',
      'pool-created',
    ]);
    expect(acts[0]!.events[1]!.payload).toMatchObject({ name: 'Front' });
    expect(acts[0]!.events[3]).toMatchObject({ poolId: result.poolIds[0], poolName: 'tank' });
  });

  it('R14, R77: the setup activity replays and undoes', () => {
    completeSetup(opened.db, parse(input));
    const log = exportData(opened.db).data.activities;
    expect(plain(replay(log))).toEqual(plain(snapshotState(opened.db)));
    const back = undoAll(replay(log), log);
    expect(plain(back).enclosures).toEqual([]);
    expect(plain(back).grids).toEqual([]);
    expect(plain(back).slots).toEqual([]);
    expect(plain(back).pools).toEqual([]);
  });

  it('R77: all or nothing - a failing pool name rolls back the layout, the log and the flag', () => {
    // The schema refuses duplicate names; a pool-name clash can only come from the database, so make one.
    opened.sqlite.exec(
      "insert into pools (id, name, created_at, updated_at) values ('p0', 'tank', 'x', 'x')",
    );
    expect(() => completeSetup(opened.db, parse(input))).toThrow();
    expect(createLayoutService(opened.db).getLayout().enclosures).toEqual([]);
    expect(countActivities(opened.db)).toBe(0);
    expect(getSetupState(opened.db)).toBe('needed');
  });

  it('R77: a bad grid is refused by the schema before anything is written', () => {
    const bad = (grids: unknown) =>
      setupInputSchema.safeParse({ enclosureName: 'NAS', grids }).success;
    expect(bad([])).toBe(false);
    expect(bad([{ name: 'A', rows: 0, columns: 1, orientation: 'landscape' }])).toBe(false);
    expect(bad([{ name: 'A', rows: 101, columns: 1, orientation: 'landscape' }])).toBe(false);
    expect(bad([{ name: ' ', rows: 1, columns: 1, orientation: 'landscape' }])).toBe(false);
    expect(bad([{ name: 'A', rows: 1, columns: 2, orientation: 'sideways' }])).toBe(false);
    // One label per bay.
    expect(
      bad([{ name: 'A', rows: 1, columns: 2, orientation: 'landscape', labels: ['only one'] }]),
    ).toBe(false);
    // Unique names.
    const g = { rows: 1, columns: 1, orientation: 'landscape' };
    expect(
      bad([
        { name: 'A', ...g },
        { name: 'A', ...g },
      ]),
    ).toBe(false);
    expect(
      setupInputSchema.safeParse({
        enclosureName: 'NAS',
        grids: [{ name: 'A', ...g }],
        pools: [{ name: 'p' }, { name: 'p' }],
      }).success,
    ).toBe(false);
  });

  it('R77: refused with 409 when an enclosure already exists; nothing is written', () => {
    createLayoutService(opened.db).createEnclosure({ name: 'Mine' });
    const before = countActivities(opened.db);
    expectCode(() => completeSetup(opened.db, parse(input)), 'conflict');
    expect(countActivities(opened.db)).toBe(before);
    expect(createLayoutService(opened.db).getLayout().enclosures).toHaveLength(1);
  });
});

describe('R77: skipping', () => {
  it('sets the flag to skipped and writes no activity', () => {
    skipSetup(opened.db);
    expect(getSetupState(opened.db)).toBe('skipped');
    expect(countActivities(opened.db)).toBe(0);
  });

  it('a skipped install can still run the setup afterwards', () => {
    skipSetup(opened.db);
    completeSetup(opened.db, parse(input));
    expect(getSetupState(opened.db)).toBe('done');
  });

  it('stays done after the user deletes the enclosure (the wizard does not return)', () => {
    completeSetup(opened.db, parse(input));
    createLayoutService(opened.db).deleteEnclosure(
      createLayoutService(opened.db).getLayout().enclosures[0]!.id,
    );
    expect(getSetupState(opened.db)).toBe('done');
  });

  it('is refused once an enclosure exists', () => {
    completeSetup(opened.db, parse(input));
    expectCode(() => skipSetup(opened.db), 'conflict');
  });
});

describe('R77: HTTP API', () => {
  it('GET /api/setup, POST /api/setup, then 409 for a second setup', async () => {
    const app = buildApp({ db: opened.db });
    const get = async () =>
      setupStateResponseSchema.parse(
        (await app.inject({ method: 'GET', url: '/api/setup' })).json(),
      ).state;
    expect(await get()).toBe('needed');

    const res = await app.inject({ method: 'POST', url: '/api/setup', payload: input });
    expect(res.statusCode).toBe(201);
    const body = setupResultSchema.parse(res.json());
    expect(body.gridIds).toHaveLength(2);
    expect(await get()).toBe('done');

    const again = await app.inject({ method: 'POST', url: '/api/setup', payload: input });
    expect(again.statusCode).toBe(409);
    await app.close();
  });

  it('POST /api/setup answers 400 for a bad body and writes nothing', async () => {
    const app = buildApp({ db: opened.db });
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: { enclosureName: 'NAS', grids: [] },
    });
    expect(res.statusCode).toBe(400);
    expect(countActivities(opened.db)).toBe(0);
    expect(getSetupState(opened.db)).toBe('needed');
    await app.close();
  });

  it('POST /api/setup/skip sets the flag; GET /api/layout is still empty', async () => {
    const app = buildApp({ db: opened.db });
    const skip = await app.inject({ method: 'POST', url: '/api/setup/skip', payload: {} });
    expect(skip.statusCode).toBe(200);
    const state = await app.inject({ method: 'GET', url: '/api/setup' });
    expect(state.json()).toEqual({ state: 'skipped' });
    const layout = await app.inject({ method: 'GET', url: '/api/layout' });
    expect(layout.json()).toEqual({ enclosures: [] });
    await app.close();
  });
});

describe('incompatible pre-release database', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sparrow-old-db-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('a current database has nothing missing', () => {
    expect(missingSchemaParts(opened.sqlite)).toEqual([]);
  });

  it('refuses a database with the migration journal but an old table set, naming the files', () => {
    const file = path.join(dir, 'app.db');
    // Build it with the real migrations, then swap the tables for an old shape: the journal still
    // says everything is applied, so the migrator alone would accept it.
    const first = openDatabase(file);
    first.sqlite.pragma('foreign_keys = OFF');
    first.sqlite.exec('drop table events; drop table activities; drop table pools;');
    first.sqlite.exec('create table events (id text primary key, drive_id text, type text)');
    first.sqlite.close();

    let caught: unknown;
    try {
      openDatabase(file);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(IncompatibleDatabaseError);
    const message = (caught as Error).message;
    expect(message).toContain('incompatible pre-release build of Sparrow');
    expect(message).toContain(`delete app.db, app.db-wal and app.db-shm in ${dir}`);
  });

  it('refuses a database whose table lacks a current column', () => {
    const file = path.join(dir, 'app.db');
    const first = openDatabase(file);
    first.sqlite.close();
    const raw = new Database(file);
    raw.exec('alter table pools rename column layout_label to layout');
    raw.close();
    expect(() => openDatabase(file)).toThrow(IncompatibleDatabaseError);
  });

  it('start() stops with that error before listening', async () => {
    const first = openDatabase(path.join(dir, 'app.db'));
    first.sqlite.pragma('foreign_keys = OFF');
    first.sqlite.exec('drop table installations');
    first.sqlite.close();
    await expect(start({ DATA_DIR: dir, PROVIDER: 'none', PORT: '13531' })).rejects.toBeInstanceOf(
      IncompatibleDatabaseError,
    );
  });
});
