import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { assignDrive } from '../src/core/assignment.js';
import { createDrive } from '../src/core/drives.js';
import { createLayoutService } from '../src/core/layout.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';

let opened: OpenedDatabase;
let app: FastifyInstance;

beforeEach(async () => {
  opened = openDatabase(':memory:');
  app = buildApp({ db: opened.db });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  opened.sqlite.close();
});

let slotIds: string[] = [];
let nextSlot = 0;

beforeEach(() => {
  const layout = createLayoutService(opened.db);
  const enclosure = layout.createEnclosure({ name: 'NAS' });
  const grid = layout.createGrid(enclosure.id, {
    name: 'Front',
    rows: 1,
    columns: 4,
    orientation: 'landscape',
  });
  slotIds = layout
    .getLayout()
    .enclosures.flatMap((e) => e.grids)
    .find((g) => g.id === grid.id)!
    .slots.map((s) => s.id);
  nextSlot = 0;
});

const call = (method: string, url: string, payload?: unknown) =>
  app.inject({ method: method as 'GET', url, payload: payload as object | undefined });

/** Creates a drive and installs it in the next free slot of the test grid. */
function installed(serial: string, poolId?: string | null): { driveId: string } {
  const d = createDrive(opened.db, { serial });
  assignDrive(opened.db, { driveId: d.id, slotId: slotIds[nextSlot++]!, poolId });
  return { driveId: d.id };
}

describe('pool API (R30, R29, R33, R36)', () => {
  it('POST /api/pools creates (201) and rejects a duplicate name (409) and bad input (400)', async () => {
    const ok = await call('POST', '/api/pools', { name: ' tank ', layoutLabel: 'raidz2' });
    expect(ok.statusCode).toBe(201);
    expect(ok.json()).toMatchObject({ name: 'tank', layoutLabel: 'raidz2' });

    const dup = await call('POST', '/api/pools', { name: 'tank' });
    expect(dup.statusCode).toBe(409);
    expect(dup.json()).toMatchObject({ error: { code: 'conflict' } });

    const blank = await call('POST', '/api/pools', { name: '   ' });
    expect(blank.statusCode).toBe(400);
    const extra = await call('POST', '/api/pools', { name: 'x', source: 'provider' });
    expect(extra.statusCode).toBe(400);
  });

  it('GET /api/pools lists pools with member counts; GET /api/pools/:id includes members', async () => {
    const pool = (await call('POST', '/api/pools', { name: 'tank' })).json() as { id: string };
    installed('A', pool.id);
    const list = (await call('GET', '/api/pools')).json() as {
      name: string;
      memberCount: number;
    }[];
    expect(list).toEqual([expect.objectContaining({ name: 'tank', memberCount: 1 })]);

    const detail = await call('GET', `/api/pools/${pool.id}`);
    expect(detail.statusCode).toBe(200);
    expect(detail.json()).toMatchObject({
      name: 'tank',
      members: [expect.objectContaining({ serial: 'A', role: 'data', slotLabel: 'Slot 1' })],
    });
    expect((await call('GET', '/api/pools/nope')).statusCode).toBe(404);
  });

  it('PATCH /api/pools/:id renames (409 on clash, 404 unknown, 400 when empty)', async () => {
    const a = (await call('POST', '/api/pools', { name: 'a' })).json() as { id: string };
    await call('POST', '/api/pools', { name: 'b' });
    const ok = await call('PATCH', `/api/pools/${a.id}`, { layoutLabel: 'mirror' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ name: 'a', layoutLabel: 'mirror' });
    expect((await call('PATCH', `/api/pools/${a.id}`, { name: 'b' })).statusCode).toBe(409);
    expect((await call('PATCH', '/api/pools/nope', { name: 'z' })).statusCode).toBe(404);
    expect((await call('PATCH', `/api/pools/${a.id}`, {})).statusCode).toBe(400);
  });

  it('DELETE /api/pools/:id removes an unused pool (204) and refuses one a drive is installed in (409)', async () => {
    const unused = (await call('POST', '/api/pools', { name: 'unused' })).json() as { id: string };
    expect((await call('DELETE', `/api/pools/${unused.id}`)).statusCode).toBe(204);

    const used = (await call('POST', '/api/pools', { name: 'used' })).json() as { id: string };
    const { driveId } = installed('B', used.id);
    expect((await call('DELETE', `/api/pools/${used.id}`)).statusCode).toBe(409);
    expect((await call('GET', `/api/pools/${used.id}`)).statusCode).toBe(200);
    // Once nothing references it, the pool can go; its history stays readable by id.
    await call('DELETE', `/api/drives/${driveId}/membership`);
    expect((await call('DELETE', `/api/pools/${used.id}`)).statusCode).toBe(204);
    const history = await call('GET', `/api/pools/${used.id}/history`);
    expect(history.statusCode).toBe(404); // the pool record is gone, so the route cannot vouch for it
  });

  it('membership routes: join, change, leave, and the pool history with whole activities', async () => {
    const a = (await call('POST', '/api/pools', { name: 'a' })).json() as { id: string };
    const b = (await call('POST', '/api/pools', { name: 'b' })).json() as { id: string };
    const { driveId } = installed('C');

    const join = await call('POST', `/api/drives/${driveId}/membership`, {
      poolId: a.id,
      role: 'hot-spare',
    });
    expect(join.statusCode).toBe(201);
    expect(join.json()).toMatchObject({ driveId, poolId: a.id, poolRole: 'hot-spare' });

    const again = await call('POST', `/api/drives/${driveId}/membership`, { poolId: b.id });
    expect(again.statusCode).toBe(409);

    const role = await call('PATCH', `/api/drives/${driveId}/membership`, { role: 'data' });
    expect(role.statusCode).toBe(200);
    expect(role.json()).toMatchObject({ poolId: a.id, poolRole: 'data' });

    const move = await call('PATCH', `/api/drives/${driveId}/membership`, { poolId: b.id });
    expect(move.json()).toMatchObject({ poolId: b.id, poolRole: 'data' });

    const history = (await call('GET', `/api/pools/${a.id}/history`)).json() as {
      kind: string;
      events: { type: string }[];
    }[];
    expect(history.map((h) => h.kind)).toEqual([
      'pool-changed',
      'pool-role-changed',
      'pool-joined',
      'pool-edited',
    ]);
    expect(history[0]!.events.map((e) => e.type)).toEqual(['pool-left', 'pool-joined']);

    const leave = await call('DELETE', `/api/drives/${driveId}/membership`, {});
    expect(leave.statusCode).toBe(200);
    expect(leave.json()).toMatchObject({ driveId, poolId: null, poolRole: null });
    expect((await call('DELETE', `/api/drives/${driveId}/membership`)).statusCode).toBe(409);
    // The membership list endpoint is gone: history is in the activity log.
    expect((await call('GET', `/api/drives/${driveId}/memberships`)).statusCode).toBe(404);
  });

  it('R33: joining a spare is 409, and unknown drives are 404 on membership routes', async () => {
    const pool = (await call('POST', '/api/pools', { name: 'tank' })).json() as { id: string };
    const spare = createDrive(opened.db, { serial: 'SPARE' });
    expect(
      (await call('POST', `/api/drives/${spare.id}/membership`, { poolId: pool.id })).statusCode,
    ).toBe(409);
    expect(
      (await call('POST', '/api/drives/nope/membership', { poolId: pool.id })).statusCode,
    ).toBe(404);
  });

  it('membership bodies reject unknown fields and a non-manual source', async () => {
    const pool = (await call('POST', '/api/pools', { name: 'tank' })).json() as { id: string };
    const { driveId } = installed('D');
    const res = await call('POST', `/api/drives/${driveId}/membership`, {
      poolId: pool.id,
      source: 'provider-suggested',
    });
    expect(res.statusCode).toBe(400);
    expect((await call('PATCH', `/api/drives/${driveId}/membership`, {})).statusCode).toBe(400);
  });
});
