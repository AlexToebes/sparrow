import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Observation } from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { assignDrive, retireDrive } from '../src/core/assignment.js';
import { createDrive } from '../src/core/drives.js';
import { createLayoutService } from '../src/core/layout.js';
import { joinPool } from '../src/core/memberships.js';
import { createPool } from '../src/core/pools.js';
import type { DriveDataProvider } from '../src/core/provider-port.js';
import { createPoller } from '../src/core/poller.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories } from '../src/db/repositories.js';
import { activitiesOf, countActivities } from './activity-helpers.js';

// R14, AGENTS rule 6 (changed 2026-10-12): every state change writes ONE activity, in the same
// transaction as the change. This test holds every mutating route to it: one successful call creates
// exactly one activity (the provider poll at most one), a failed call creates none. The one stated
// exception is POST /api/inbox/import-retired, which creates one activity PER ITEM (retirements on
// different days did not happen together), all in one transaction. POST /api/import replaces the
// whole log with the file's, so it is not an action in the log.

let opened: OpenedDatabase;
let app: FastifyInstance;
const routes: string[] = [];
const provider: DriveDataProvider = {
  id: 'fake',
  capabilities: { drives: true, pools: false },
  expectedUpdateIntervalHours: 1,
  fetchSnapshot: async () => [],
  checkConnection: async () => ({ ok: true }),
};

beforeEach(async () => {
  opened = openDatabase(':memory:');
  app = buildApp({ db: opened.db, provider });
  app.addHook('onRoute', (r) => {
    for (const method of [r.method].flat()) routes.push(`${method} ${r.url}`);
  });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  opened.sqlite.close();
});
const db = () => opened.db;

const obs = (serial: string, extra: Partial<Observation> = {}): Observation => ({
  serial,
  health: 'ok',
  lastReportedAt: '2026-03-04T05:06:07.000Z',
  state: 'active',
  ...extra,
});

/** A small, rich world every case can act on. */
function world() {
  const layout = createLayoutService(db());
  const enclosure = layout.createEnclosure({ name: 'NAS' });
  const grid = layout.createGrid(enclosure.id, {
    name: 'Front',
    rows: 1,
    columns: 6,
    orientation: 'landscape',
  });
  const slots = layout.getLayout().enclosures[0]!.grids[0]!.slots.map((s) => s.id);
  const empty = layout.createEnclosure({ name: 'Empty box' });
  const emptyGrid = layout.createGrid(empty.id, {
    name: 'Spare grid',
    rows: 1,
    columns: 1,
    orientation: 'landscape',
  });
  const pool = createPool(db(), { name: 'tank' });
  const idle = createPool(db(), { name: 'idle' });
  const installed = createDrive(db(), { serial: 'INSTALLED' });
  const second = createDrive(db(), { serial: 'SECOND' });
  const inPool = createDrive(db(), { serial: 'INPOOL' });
  const shelf = createDrive(db(), { serial: 'SHELF' });
  const shelf2 = createDrive(db(), { serial: 'SHELF2' });
  const gone = createDrive(db(), { serial: 'GONE' });
  assignDrive(db(), { driveId: installed.id, slotId: slots[0]! });
  assignDrive(db(), { driveId: second.id, slotId: slots[1]! });
  assignDrive(db(), { driveId: inPool.id, slotId: slots[2]!, poolId: pool.id });
  retireDrive(db(), gone.id, { reason: 'failed' });
  createRepositories(db()).snapshot.put({
    providerId: 'fake',
    observations: [
      obs('SHELF', { model: 'Reported' }),
      obs('FOUND-1'),
      obs('DEAD-1', { state: 'decommissioned', health: 'failed' }),
      obs('DEAD-2', { state: 'decommissioned', health: 'failed' }),
    ],
    lastSuccessAt: '2026-03-04T05:06:07.000Z',
    lastAttemptAt: '2026-03-04T05:06:07.000Z',
  });
  return {
    enclosure: enclosure.id,
    empty: empty.id,
    emptyGrid: emptyGrid.id,
    grid: grid.id,
    slots,
    pool: pool.id,
    idle: idle.id,
    installed: installed.id,
    second: second.id,
    inPool: inPool.id,
    shelf: shelf.id,
    shelf2: shelf2.id,
    gone: gone.id,
  };
}
type World = ReturnType<typeof world>;

interface Case {
  /** `METHOD /route/with/:params`, exactly as Fastify registered it. */
  route: string;
  url: (w: World) => string;
  payload?: (w: World) => object | undefined;
  /** How many activities one successful call creates. */
  creates?: number;
  /** A call that must fail and create nothing. */
  fails: { url: (w: World) => string; payload?: (w: World) => object | undefined; status: number };
}

const NO = '00000000-nope';
const CASES: Case[] = [
  {
    route: 'POST /api/drives',
    url: () => '/api/drives',
    payload: () => ({ serial: 'BRAND-NEW', model: 'M' }),
    fails: { url: () => '/api/drives', payload: () => ({}), status: 400 },
  },
  {
    route: 'PATCH /api/drives/:id',
    url: (w) => `/api/drives/${w.shelf}`,
    payload: () => ({ model: 'Edited' }),
    fails: { url: () => `/api/drives/${NO}`, payload: () => ({ model: 'x' }), status: 404 },
  },
  {
    route: 'POST /api/slots/:id/assign',
    url: (w) => `/api/slots/${w.slots[3]}/assign`,
    payload: (w) => ({ driveId: w.shelf }),
    fails: {
      url: (w) => `/api/slots/${w.slots[0]}/assign`,
      payload: (w) => ({ driveId: w.shelf }),
      status: 409,
    },
  },
  {
    route: 'POST /api/drives/:id/remove',
    url: (w) => `/api/drives/${w.installed}/remove`,
    payload: () => ({}),
    fails: { url: (w) => `/api/drives/${w.shelf}/remove`, payload: () => ({}), status: 409 },
  },
  {
    route: 'POST /api/drives/:id/move',
    url: (w) => `/api/drives/${w.installed}/move`,
    payload: (w) => ({ destination: { kind: 'slot', slotId: w.slots[4] } }),
    fails: {
      url: (w) => `/api/drives/${w.installed}/move`,
      payload: (w) => ({ destination: { kind: 'slot', slotId: w.slots[1] } }),
      status: 409,
    },
  },
  {
    route: 'POST /api/drives/:id/retire',
    url: (w) => `/api/drives/${w.installed}/retire`,
    payload: () => ({ reason: 'failed' }),
    fails: {
      url: (w) => `/api/drives/${w.gone}/retire`,
      payload: () => ({ reason: 'failed' }),
      status: 409,
    },
  },
  {
    route: 'POST /api/drives/:id/rma',
    url: (w) => `/api/drives/${w.installed}/rma`,
    payload: () => ({}),
    fails: { url: (w) => `/api/drives/${w.gone}/rma`, payload: () => ({}), status: 409 },
  },
  {
    route: 'POST /api/drives/:id/reinstate',
    url: (w) => `/api/drives/${w.gone}/reinstate`,
    payload: () => ({}),
    fails: { url: (w) => `/api/drives/${w.shelf}/reinstate`, payload: () => ({}), status: 409 },
  },
  {
    route: 'POST /api/inbox/import-retired',
    url: () => '/api/inbox/import-retired',
    payload: () => ({
      items: [
        { observationKey: 'DEAD-1', reason: 'failed', date: '2026-01-01' },
        { observationKey: 'DEAD-2', reason: 'other', date: '2026-01-02' },
      ],
    }),
    creates: 2, // the stated exception: one activity per item
    fails: {
      url: () => '/api/inbox/import-retired',
      payload: () => ({
        items: [
          { observationKey: 'DEAD-1', reason: 'failed' },
          { observationKey: 'NOPE', reason: 'failed' },
        ],
      }),
      status: 404,
    },
  },
  {
    route: 'POST /api/inbox/:key/link',
    url: () => '/api/inbox/SHELF/link',
    payload: (w) => ({ driveId: w.shelf, slotId: w.slots[3] }),
    fails: {
      url: () => '/api/inbox/SHELF/link',
      payload: (w) => ({ driveId: w.shelf, slotId: w.slots[0] }),
      status: 409,
    },
  },
  {
    route: 'POST /api/inbox/:key/create',
    url: () => '/api/inbox/FOUND-1/create',
    payload: (w) => ({ slotId: w.slots[3] }),
    fails: {
      url: () => '/api/inbox/FOUND-1/create',
      payload: (w) => ({ slotId: w.slots[0] }),
      status: 409,
    },
  },
  {
    route: 'POST /api/pools',
    url: () => '/api/pools',
    payload: () => ({ name: 'new pool' }),
    fails: { url: () => '/api/pools', payload: () => ({ name: 'tank' }), status: 409 },
  },
  {
    route: 'PATCH /api/pools/:id',
    url: (w) => `/api/pools/${w.pool}`,
    payload: () => ({ layoutLabel: 'mirror' }),
    fails: { url: (w) => `/api/pools/${w.idle}`, payload: () => ({ name: 'tank' }), status: 409 },
  },
  {
    route: 'DELETE /api/pools/:id',
    url: (w) => `/api/pools/${w.idle}`,
    fails: { url: (w) => `/api/pools/${w.pool}`, status: 409 },
  },
  {
    route: 'POST /api/drives/:id/membership',
    url: (w) => `/api/drives/${w.installed}/membership`,
    payload: (w) => ({ poolId: w.pool }),
    fails: {
      url: (w) => `/api/drives/${w.inPool}/membership`,
      payload: (w) => ({ poolId: w.pool }),
      status: 409,
    },
  },
  {
    route: 'PATCH /api/drives/:id/membership',
    url: (w) => `/api/drives/${w.inPool}/membership`,
    payload: () => ({ role: 'hot-spare' }),
    fails: {
      url: (w) => `/api/drives/${w.installed}/membership`,
      payload: () => ({ role: 'hot-spare' }),
      status: 409,
    },
  },
  {
    route: 'DELETE /api/drives/:id/membership',
    url: (w) => `/api/drives/${w.inPool}/membership`,
    payload: () => ({}),
    fails: {
      url: (w) => `/api/drives/${w.installed}/membership`,
      payload: () => ({}),
      status: 409,
    },
  },
  {
    route: 'POST /api/enclosures',
    url: () => '/api/enclosures',
    payload: () => ({ name: 'Another box' }),
    fails: { url: () => '/api/enclosures', payload: () => ({ name: '' }), status: 400 },
  },
  {
    route: 'PATCH /api/enclosures/:id',
    url: (w) => `/api/enclosures/${w.enclosure}`,
    payload: () => ({ name: 'Renamed NAS' }),
    fails: { url: () => `/api/enclosures/${NO}`, payload: () => ({ name: 'x' }), status: 404 },
  },
  {
    route: 'DELETE /api/enclosures/:id',
    url: (w) => `/api/enclosures/${w.empty}`,
    fails: { url: (w) => `/api/enclosures/${w.enclosure}`, status: 409 },
  },
  {
    route: 'POST /api/enclosures/:id/grids',
    url: (w) => `/api/enclosures/${w.enclosure}/grids`,
    payload: () => ({ name: 'Rear', rows: 1, columns: 2, orientation: 'landscape' }),
    fails: {
      url: (w) => `/api/enclosures/${w.enclosure}/grids`,
      payload: () => ({ name: 'Front', rows: 1, columns: 2, orientation: 'landscape' }),
      status: 409,
    },
  },
  {
    route: 'PATCH /api/grids/:id',
    url: (w) => `/api/grids/${w.grid}`,
    payload: () => ({ name: 'Front bays' }),
    fails: { url: (w) => `/api/grids/${w.grid}`, payload: () => ({ columns: 1 }), status: 409 },
  },
  {
    route: 'DELETE /api/grids/:id',
    url: (w) => `/api/grids/${w.emptyGrid}`,
    fails: { url: (w) => `/api/grids/${w.grid}`, status: 409 },
  },
  {
    route: 'PATCH /api/slots/:id',
    url: (w) => `/api/slots/${w.slots[5]}`,
    payload: () => ({ label: 'Hot swap' }),
    fails: { url: () => `/api/slots/${NO}`, payload: () => ({ label: 'x' }), status: 404 },
  },
  {
    route: 'POST /api/drives/:id/suggestions/apply',
    url: (w) => `/api/drives/${w.shelf}/suggestions/apply`,
    payload: () => ({ fields: ['model'] }),
    fails: {
      url: (w) => `/api/drives/${w.shelf2}/suggestions/apply`,
      payload: () => ({ fields: ['model'] }),
      status: 409,
    },
  },
  {
    route: 'POST /api/drives/:id/suggestions/dismiss',
    url: (w) => `/api/drives/${w.shelf}/suggestions/dismiss`,
    payload: () => ({ fields: ['model'] }),
    fails: {
      url: (w) => `/api/drives/${w.shelf2}/suggestions/dismiss`,
      payload: () => ({ fields: ['model'] }),
      status: 409,
    },
  },
  {
    route: 'POST /api/drives/:id/suggestions/undismiss',
    url: (w) => `/api/drives/${w.shelf}/suggestions/undismiss`,
    payload: () => ({ fields: ['model'] }),
    fails: {
      url: (w) => `/api/drives/${w.shelf2}/suggestions/undismiss`,
      payload: () => ({ fields: ['model'] }),
      status: 409,
    },
  },
];

/**
 * Routes that mutate but are not covered by the table. POST /api/setup is an action (ONE activity) but
 * only works on an empty layout, which `world()` is not: it has its own test below. POST /api/setup/skip
 * only sets the `setup` flag in app_meta (no drive, bay or pool changes), so it logs nothing.
 */
const NOT_ACTIONS = new Set(['POST /api/import', 'POST /api/setup', 'POST /api/setup/skip']);

const inject = (method: string, url: string, payload?: object) =>
  app.inject({
    method: method as 'POST',
    url,
    ...(method === 'GET' ? {} : { payload: payload ?? {} }),
  });

describe('R14: every mutating route records exactly one activity', () => {
  it('the table covers every mutating route the server registers', () => {
    const mutating = routes.filter((r) => /^(POST|PATCH|PUT|DELETE) /.test(r));
    const covered = new Set([...CASES.map((c) => c.route), ...NOT_ACTIONS]);
    expect(mutating.filter((r) => !covered.has(r))).toEqual([]);
    expect(CASES.map((c) => c.route).filter((r) => !mutating.includes(r))).toEqual([]);
  });

  it.each(CASES.map((c) => [c.route, c] as const))(
    '%s: one successful call = one activity; a failed call = none',
    async (_route, c) => {
      const w = world();
      // The undismiss case needs something dismissed first (a setup action, not the call under test).
      if (c.route.endsWith('/undismiss')) {
        await inject('POST', `/api/drives/${w.shelf}/suggestions/dismiss`, { fields: ['model'] });
      }
      const method = c.route.split(' ')[0]!;

      const before = countActivities(db());
      const failed = await inject(method, c.fails.url(w), c.fails.payload?.(w));
      expect(failed.statusCode).toBe(c.fails.status);
      expect(countActivities(db())).toBe(before);

      const ok = await inject(method, c.url(w), c.payload?.(w));
      expect(ok.statusCode, ok.body).toBeLessThan(300);
      expect(countActivities(db()) - before).toBe(c.creates ?? 1);
      // Every activity holds at least one event, and ordinals run from 0.
      for (const a of activitiesOf(db()).slice(before)) {
        expect(a.events.length).toBeGreaterThan(0);
        expect(a.events.map((e) => e.ord)).toEqual(a.events.map((_, i) => i));
      }
    },
  );

  it('POST /api/inbox/import-retired: one activity per item, all in one transaction (all or nothing)', async () => {
    const w = world();
    const before = countActivities(db());
    const res = await inject('POST', '/api/inbox/import-retired', {
      items: [
        { observationKey: 'DEAD-1', reason: 'failed', date: '2026-01-01' },
        { observationKey: 'DEAD-2', reason: 'other', date: null },
      ],
    });
    expect(res.statusCode).toBe(200);
    const added = activitiesOf(db()).slice(before);
    expect(added.map((a) => [a.kind, a.occurredOn])).toEqual([
      ['retired-imported', '2026-01-01'],
      ['retired-imported', null],
    ]);
    void w;
  });

  it('POST /api/setup: one successful call on an empty layout = one activity; a refused call = none', async () => {
    const body = {
      enclosureName: 'NAS',
      grids: [{ name: 'Front', rows: 1, columns: 2, orientation: 'landscape' }],
      pools: [{ name: 'tank' }],
    };
    expect((await inject('POST', '/api/setup', { enclosureName: 'x', grids: [] })).statusCode).toBe(
      400,
    );
    expect(countActivities(db())).toBe(0);
    expect((await inject('POST', '/api/setup', body)).statusCode).toBe(201);
    expect(countActivities(db())).toBe(1);
    expect((await inject('POST', '/api/setup', body)).statusCode).toBe(409);
    expect(countActivities(db())).toBe(1);
  });

  it('reads never write: no GET route creates an activity', async () => {
    const w = world();
    const before = countActivities(db());
    for (const url of [
      '/api/layout',
      '/api/drives',
      `/api/drives/${w.installed}`,
      `/api/drives/${w.installed}/history`,
      `/api/drives/${w.shelf}/suggestions`,
      '/api/suggestions',
      '/api/pools',
      `/api/pools/${w.pool}`,
      `/api/pools/${w.pool}/history`,
      `/api/slots/${w.slots[0]}/history`,
      `/api/slots/${w.slots[0]}/assignment-defaults`,
      '/api/activities/recent',
      '/api/inbox',
      '/api/status',
      '/api/export',
      '/api/provider/status',
      '/api/health',
    ]) {
      const res = await inject('GET', url);
      expect(res.statusCode, url).toBe(200);
    }
    expect(countActivities(db())).toBe(before);
  });

  it('the provider poll records at most one activity (health-polled), and none when nothing changed', async () => {
    createDrive(db(), { serial: 'AAA' });
    createDrive(db(), { serial: 'BBB' });
    let health: Observation['health'] = 'ok';
    const poller = createPoller({
      db: db(),
      provider: {
        ...provider,
        fetchSnapshot: async () => [obs('AAA', { health }), obs('BBB', { health })],
      },
      intervalMs: 1000,
      now: () => new Date('2026-03-05T00:00:00.000Z'),
    });
    const before = countActivities(db());
    await poller.pollOnce();
    expect(countActivities(db())).toBe(before + 1); // two drives, ONE activity
    await poller.pollOnce();
    expect(countActivities(db())).toBe(before + 1); // nothing changed: none
    health = 'warning';
    await poller.pollOnce();
    expect(countActivities(db())).toBe(before + 2);
    expect(activitiesOf(db()).at(-1)!.events).toHaveLength(2);
  });

  it('the same holds when a core service is called directly (join a pool)', () => {
    const w = world();
    const before = countActivities(db());
    joinPool(db(), w.installed, { poolId: w.pool });
    expect(countActivities(db())).toBe(before + 1);
  });
});
