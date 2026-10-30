import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  driveConflictViewsSchema,
  poolDetailSchema,
  poolSummarySchema,
  slotCompatibilitySchema,
} from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { assignDrive, removeToSpares, retireDrive } from '../src/core/assignment.js';
import { exportData } from '../src/core/backup.js';
import { getSlotCompatibility } from '../src/core/compatibility.js';
import {
  addConflict,
  listDriveConflicts,
  poolConflicts,
  removeConflict,
} from '../src/core/conflicts.js';
import { createDrive } from '../src/core/drives.js';
import { DomainError } from '../src/core/errors.js';
import { createLayoutService } from '../src/core/layout.js';
import { listPools } from '../src/core/pools.js';
import { createPool } from '../src/core/pools.js';
import { plain, replay, snapshotState, undoAll } from '../src/core/replay.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { driveConflicts, events } from '../src/db/schema.js';
import { activitiesOf, byDrive, countActivities, lastActivity } from './activity-helpers.js';

// R78: drives that are not recommended together. A symmetric pair stored once; advice only.

let opened: OpenedDatabase;
let app: FastifyInstance;
let slots: string[];
const db = () => opened.db;

beforeEach(async () => {
  opened = openDatabase(':memory:');
  app = buildApp({ db: opened.db });
  await app.ready();
  const layout = createLayoutService(opened.db);
  const enc = layout.createEnclosure({ name: 'NAS' });
  layout.createGrid(enc.id, { name: 'Front', rows: 1, columns: 6, orientation: 'landscape' });
  slots = layout.getLayout().enclosures[0]!.grids[0]!.slots.map((s) => s.id);
});
afterEach(async () => {
  await app.close();
  opened.sqlite.close();
});

const drive = (serial: string, extra: Record<string, unknown> = {}) =>
  createDrive(db(), { serial, driveType: 'HDD', capacityBytes: 4e12, ...extra });
const code = (fn: () => unknown): string => {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err.code;
    throw err;
  }
  return 'ok';
};
const call = (method: string, url: string, payload?: unknown) =>
  app.inject({
    method: method as 'GET',
    url,
    payload: (payload ?? (method === 'GET' ? undefined : {})) as object | undefined,
  });

describe('R78: marking and unmarking a pair (core)', () => {
  it('R78: a pair is stored once, in canonical order, whichever drive it is added from', () => {
    const a = drive('WD-A');
    const b = drive('WD-B');
    addConflict(db(), b.id, { otherDriveId: a.id, reason: 'Same batch' });
    const rows = db().select().from(driveConflicts).all();
    expect(rows).toHaveLength(1);
    const [lo, hi] = [a.id, b.id].sort();
    expect(rows[0]).toMatchObject({ driveAId: lo, driveBId: hi, reason: 'Same batch' });
  });

  it('R78: both drives list the pair, each showing the OTHER drive with its facts', () => {
    const a = drive('WD-A', { model: 'Red', capacityBytes: 4e12 });
    const b = drive('WD-B', { model: 'Red Plus', capacityBytes: 6e12 });
    addConflict(db(), a.id, { otherDriveId: b.id, reason: '  Same batch ' });
    const fromA = listDriveConflicts(db(), a.id);
    expect(fromA).toEqual([
      expect.objectContaining({
        otherDriveId: b.id,
        serial: 'WD-B',
        model: 'Red Plus',
        capacityBytes: 6e12,
        status: 'spare',
        where: null,
        reason: 'Same batch', // trimmed
      }),
    ]);
    expect(listDriveConflicts(db(), b.id)).toEqual([
      expect.objectContaining({ otherDriveId: a.id, serial: 'WD-A', model: 'Red' }),
    ]);
  });

  it('R78: an installed partner shows where it sits, and an empty reason is no reason', () => {
    const a = drive('WD-A');
    const b = drive('WD-B');
    assignDrive(db(), { driveId: b.id, slotId: slots[2]! });
    addConflict(db(), a.id, { otherDriveId: b.id, reason: '   ' });
    expect(listDriveConflicts(db(), a.id)[0]).toMatchObject({
      status: 'installed',
      where: 'Front, Slot 3',
      reason: null,
    });
  });

  it('R78: a drive cannot conflict with itself (invalid), an unknown drive is not found, a duplicate pair (either way round) conflicts', () => {
    const a = drive('WD-A');
    const b = drive('WD-B');
    expect(code(() => addConflict(db(), a.id, { otherDriveId: a.id }))).toBe('invalid');
    expect(code(() => addConflict(db(), a.id, { otherDriveId: 'nope' }))).toBe('not-found');
    expect(code(() => addConflict(db(), 'nope', { otherDriveId: a.id }))).toBe('not-found');
    addConflict(db(), a.id, { otherDriveId: b.id });
    expect(code(() => addConflict(db(), a.id, { otherDriveId: b.id }))).toBe('conflict');
    expect(code(() => addConflict(db(), b.id, { otherDriveId: a.id }))).toBe('conflict');
    expect(db().select().from(driveConflicts).all()).toHaveLength(1);
  });

  it('R78: removing works from either drive; removing a pair that is not there is not found', () => {
    const a = drive('WD-A');
    const b = drive('WD-B');
    const c = drive('WD-C');
    expect(code(() => removeConflict(db(), a.id, b.id))).toBe('not-found');
    expect(code(() => removeConflict(db(), a.id, 'nope'))).toBe('not-found');
    addConflict(db(), a.id, { otherDriveId: b.id });
    addConflict(db(), c.id, { otherDriveId: a.id });
    removeConflict(db(), b.id, a.id);
    expect(listDriveConflicts(db(), a.id).map((v) => v.serial)).toEqual(['WD-C']);
    expect(listDriveConflicts(db(), b.id)).toEqual([]);
  });

  it('R78: retired drives may be paired and keep their pairs when retired', () => {
    const a = drive('WD-A');
    const b = drive('WD-B');
    addConflict(db(), a.id, { otherDriveId: b.id, reason: 'Same batch' });
    retireDrive(db(), b.id, { reason: 'failed' });
    expect(listDriveConflicts(db(), a.id)).toEqual([
      expect.objectContaining({ serial: 'WD-B', status: 'retired', reason: 'Same batch' }),
    ]);
    const old = drive('WD-OLD');
    retireDrive(db(), old.id, { reason: 'other' });
    addConflict(db(), a.id, { otherDriveId: old.id }); // pairing a retired drive is allowed
    expect(listDriveConflicts(db(), a.id)).toHaveLength(2);
  });

  it('R78: the drives are never deleted while paired (RESTRICT is the backstop)', () => {
    const a = drive('WD-A');
    const b = drive('WD-B');
    addConflict(db(), a.id, { otherDriveId: b.id });
    expect(() => opened.sqlite.prepare('DELETE FROM drives WHERE id = ?').run(a.id)).toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe('R14, R78: one activity of two atomic events', () => {
  it('R78: adding is ONE activity `conflict-added` with two events, one per drive, each with the other drive, its serial and the reason', () => {
    const a = drive('WD-A');
    const b = drive('WD-B');
    const before = countActivities(db());
    addConflict(db(), a.id, { otherDriveId: b.id, reason: 'Same batch' });
    expect(countActivities(db())).toBe(before + 1);
    const act = lastActivity(db());
    expect(act.kind).toBe('conflict-added');
    expect(byDrive(act)).toEqual([
      [a.id, 'conflict-added'],
      [b.id, 'conflict-added'],
    ]);
    expect(act.events.map((e) => e.payload)).toEqual([
      { otherDriveId: b.id, otherSerial: 'WD-B', reason: 'Same batch' },
      { otherDriveId: a.id, otherSerial: 'WD-A', reason: 'Same batch' },
    ]);
    // Each event is about one drive and no slot or pool.
    for (const e of act.events) expect([e.slotId, e.poolId]).toEqual([null, null]);
  });

  it('R78: removing is ONE activity `conflict-removed` with two events that keep the reason (and when the pair was made) so undo restores it', () => {
    const a = drive('WD-A');
    const b = drive('WD-B');
    addConflict(db(), a.id, { otherDriveId: b.id, reason: 'Same purchase' });
    const created = db().select().from(driveConflicts).get()!.createdAt;
    const before = countActivities(db());
    removeConflict(db(), b.id, a.id);
    expect(countActivities(db())).toBe(before + 1);
    const act = lastActivity(db());
    expect(act.kind).toBe('conflict-removed');
    expect(byDrive(act)).toEqual([
      [b.id, 'conflict-removed'],
      [a.id, 'conflict-removed'],
    ]);
    expect(act.events.map((e) => e.payload)).toEqual([
      { otherDriveId: a.id, otherSerial: 'WD-A', reason: 'Same purchase', createdAt: created },
      { otherDriveId: b.id, otherSerial: 'WD-B', reason: 'Same purchase', createdAt: created },
    ]);
  });

  it('R78: a refused call writes nothing', () => {
    const a = drive('WD-A');
    const before = countActivities(db());
    expect(code(() => addConflict(db(), a.id, { otherDriveId: a.id }))).toBe('invalid');
    expect(code(() => addConflict(db(), a.id, { otherDriveId: 'nope' }))).toBe('not-found');
    expect(code(() => removeConflict(db(), a.id, a.id))).toBe('not-found');
    expect(countActivities(db())).toBe(before);
  });

  it('R14, R78: replay rebuilds the pairs, and undo takes each activity back, one by one', () => {
    const a = drive('WD-A');
    const b = drive('WD-B');
    const c = drive('WD-C');
    const states = [plain(snapshotState(db()))];
    const counts = [activitiesOf(db()).length];
    const step = (fn: () => void) => {
      fn();
      states.push(plain(snapshotState(db())));
      counts.push(activitiesOf(db()).length);
    };
    step(() => addConflict(db(), a.id, { otherDriveId: b.id, reason: 'Same batch' }));
    step(() => addConflict(db(), c.id, { otherDriveId: a.id }));
    step(() => removeConflict(db(), a.id, b.id));
    step(() => addConflict(db(), b.id, { otherDriveId: a.id, reason: 'Again' }));
    step(() => retireDrive(db(), c.id, { reason: 'failed' })); // the pair stays
    const all = activitiesOf(db());
    expect(plain(snapshotState(db())).driveConflicts).toHaveLength(2);
    expect(plain(replay(all))).toEqual(plain(snapshotState(db())));
    states.forEach((state, i) => {
      const upTo = all.filter((x) => x.seq <= counts[i]!);
      expect(plain(replay(upTo)), `after step ${i}`).toEqual(state);
      const newer = all.filter((x) => x.seq > counts[i]!);
      expect(plain(undoAll(snapshotState(db()), newer)), `back to step ${i}`).toEqual(state);
    });
  });
});

describe('R78: pool warning (R34-style, computed on every read)', () => {
  function pool(...serials: string[]) {
    const p = createPool(db(), { name: 'tank' });
    const ids: Record<string, string> = {};
    serials.forEach((s, i) => {
      const d = drive(s);
      ids[s] = d.id;
      assignDrive(db(), { driveId: d.id, slotId: slots[i]!, poolId: p.id });
    });
    return { pool: p, ids };
  }

  it('R78: two current members that are a pair are reported, with serials and reason', () => {
    const { pool: p, ids } = pool('WD-A', 'WD-B', 'WD-C');
    expect(poolConflicts(db(), p.id)).toEqual([]);
    addConflict(db(), ids['WD-B']!, { otherDriveId: ids['WD-A']!, reason: 'Same batch' });
    expect(poolConflicts(db(), p.id)).toEqual([
      {
        driveAId: ids['WD-A'],
        serialA: 'WD-A',
        driveBId: ids['WD-B'],
        serialB: 'WD-B',
        reason: 'Same batch',
      },
    ]);
    expect(listPools(db())[0]!.conflicts).toHaveLength(1);
  });

  it('R78: a pair with only one member in the pool is not a warning, and it follows the members as they change', () => {
    const { pool: p, ids } = pool('WD-A', 'WD-B');
    const outside = drive('WD-OUT');
    addConflict(db(), ids['WD-A']!, { otherDriveId: outside.id });
    expect(poolConflicts(db(), p.id)).toEqual([]);
    addConflict(db(), ids['WD-A']!, { otherDriveId: ids['WD-B']! });
    expect(poolConflicts(db(), p.id)).toHaveLength(1);
    removeToSpares(db(), ids['WD-B']!, {});
    expect(poolConflicts(db(), p.id)).toEqual([]); // the member left: nothing is stored about it
    assignDrive(db(), { driveId: ids['WD-B']!, slotId: slots[4]!, poolId: p.id });
    expect(poolConflicts(db(), p.id)).toHaveLength(1);
  });

  it('R78: a retired drive never causes a warning, and its pair is kept', () => {
    const { pool: p, ids } = pool('WD-A', 'WD-B');
    addConflict(db(), ids['WD-A']!, { otherDriveId: ids['WD-B']! });
    retireDrive(db(), ids['WD-B']!, { reason: 'failed' });
    expect(poolConflicts(db(), p.id)).toEqual([]);
    expect(listPools(db())[0]!.conflicts).toEqual([]);
    expect(listDriveConflicts(db(), ids['WD-A']!)).toHaveLength(1);
  });

  it('R78: the API puts conflicts on the pool list and the pool detail (and they parse with the shared schemas)', async () => {
    const { pool: p, ids } = pool('WD-A', 'WD-B');
    const none = poolDetailSchema.parse((await call('GET', `/api/pools/${p.id}`)).json());
    expect(none.conflicts).toEqual([]);
    await call('POST', `/api/drives/${ids['WD-A']}/conflicts`, {
      otherDriveId: ids['WD-B'],
      reason: 'Same batch',
    });
    const detail = poolDetailSchema.parse((await call('GET', `/api/pools/${p.id}`)).json());
    expect(detail.conflicts).toEqual([
      expect.objectContaining({ serialA: 'WD-A', serialB: 'WD-B', reason: 'Same batch' }),
    ]);
    const list = poolSummarySchema.array().parse((await call('GET', '/api/pools')).json());
    expect(list[0]!.conflicts).toHaveLength(1);
  });
});

describe('R78, R12: spare compatibility notes', () => {
  /** A pool of three in bays 0-2 (WD-A, WD-B, WD-C) and spares on the shelf. */
  function world() {
    const p = createPool(db(), { name: 'tank' });
    const member = (serial: string, slot: number) => {
      const d = drive(serial);
      assignDrive(db(), { driveId: d.id, slotId: slots[slot]!, poolId: p.id });
      return d;
    };
    const a = member('WD-A', 0);
    const b = member('WD-B', 1);
    const c = member('WD-C', 2);
    return { a, b, c, p };
  }
  const spareOf = (res: ReturnType<typeof getSlotCompatibility>, id: string) =>
    res.spares.find((s) => s.driveId === id)!;

  it('R78: a spare that is paired with a current member of the target pool carries a conflict note, and its verdict is unchanged', () => {
    const { b } = world();
    const spare = drive('WD-NEW');
    const other = drive('WD-OTHER');
    const before = spareOf(getSlotCompatibility(db(), slots[0]!), spare.id);
    addConflict(db(), spare.id, { otherDriveId: b.id, reason: 'Same batch' });
    const res = getSlotCompatibility(db(), slots[0]!);
    expect(spareOf(res, spare.id).conflicts).toEqual([
      { driveId: b.id, serial: 'WD-B', reason: 'Same batch' },
    ]);
    expect(spareOf(res, spare.id).verdict).toBe(before.verdict);
    expect(spareOf(res, spare.id).reason).toBe(before.reason);
    expect(spareOf(res, other.id).conflicts).toEqual([]);
  });

  it('R78: the drive being replaced is left out: a spare paired only with the outgoing drive has no note', () => {
    const { a } = world();
    const spare = drive('WD-NEW');
    addConflict(db(), spare.id, { otherDriveId: a.id, reason: 'Same batch' });
    expect(spareOf(getSlotCompatibility(db(), slots[0]!), spare.id).conflicts).toEqual([]); // bay of WD-A
    expect(spareOf(getSlotCompatibility(db(), slots[1]!), spare.id).conflicts).toEqual([
      expect.objectContaining({ serial: 'WD-A' }),
    ]); // replacing WD-B leaves WD-A in the pool
  });

  it('R78: an empty bay is checked against the pool of its previous occupant, which is no longer a member', () => {
    const { a, b } = world();
    const spare = drive('WD-NEW');
    addConflict(db(), spare.id, { otherDriveId: a.id });
    addConflict(db(), spare.id, { otherDriveId: b.id });
    removeToSpares(db(), a.id, {});
    const res = getSlotCompatibility(db(), slots[0]!);
    expect(spareOf(res, spare.id).conflicts.map((c) => c.serial)).toEqual(['WD-B']);
  });

  it('R78: a bay outside any pool has no notes; retired partners and retired drives never warn', () => {
    const { b } = world();
    const loose = drive('WD-LOOSE');
    assignDrive(db(), { driveId: loose.id, slotId: slots[5]! });
    const spare = drive('WD-NEW');
    addConflict(db(), spare.id, { otherDriveId: loose.id });
    expect(spareOf(getSlotCompatibility(db(), slots[5]!), spare.id).conflicts).toEqual([]);
    addConflict(db(), spare.id, { otherDriveId: b.id });
    retireDrive(db(), b.id, { reason: 'failed' });
    expect(spareOf(getSlotCompatibility(db(), slots[0]!), spare.id).conflicts).toEqual([]);
  });

  it('R78: the API response parses with the shared schema and lists several notes by serial', async () => {
    const { b, c } = world();
    const spare = drive('WD-NEW');
    addConflict(db(), spare.id, { otherDriveId: c.id, reason: 'Same purchase' });
    addConflict(db(), spare.id, { otherDriveId: b.id });
    const res = slotCompatibilitySchema.parse(
      (await call('GET', `/api/slots/${slots[0]}/compatibility`)).json(),
    );
    expect(spareOf(res, spare.id).conflicts).toEqual([
      { driveId: b.id, serial: 'WD-B', reason: null },
      { driveId: c.id, serial: 'WD-C', reason: 'Same purchase' },
    ]);
  });
});

describe('R78: HTTP API', () => {
  it('R78: POST creates (201) and returns the pair as seen from the drive; GET lists; DELETE removes (204)', async () => {
    const a = drive('WD-A');
    const b = drive('WD-B');
    const created = await call('POST', `/api/drives/${a.id}/conflicts`, {
      otherDriveId: b.id,
      reason: 'Same batch',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({
      otherDriveId: b.id,
      serial: 'WD-B',
      reason: 'Same batch',
    });
    const list = driveConflictViewsSchema.parse(
      (await call('GET', `/api/drives/${b.id}/conflicts`)).json(),
    );
    expect(list.map((v) => v.serial)).toEqual(['WD-A']);
    const gone = await call('DELETE', `/api/drives/${b.id}/conflicts/${a.id}`);
    expect(gone.statusCode).toBe(204);
    expect((await call('GET', `/api/drives/${a.id}/conflicts`)).json()).toEqual([]);
  });

  it('R78: 400 for the drive itself or a bad body, 404 for an unknown drive or pair, 409 for a duplicate', async () => {
    const a = drive('WD-A');
    const b = drive('WD-B');
    const post = (id: string, body: unknown) => call('POST', `/api/drives/${id}/conflicts`, body);
    expect((await post(a.id, { otherDriveId: a.id })).statusCode).toBe(400);
    expect((await post(a.id, {})).statusCode).toBe(400);
    expect((await post(a.id, { otherDriveId: b.id, reason: 'x'.repeat(201) })).statusCode).toBe(
      400,
    );
    expect((await post(a.id, { otherDriveId: b.id, nope: 1 })).statusCode).toBe(400);
    expect((await post(a.id, { otherDriveId: 'ghost' })).statusCode).toBe(404);
    expect((await post('ghost', { otherDriveId: a.id })).statusCode).toBe(404);
    expect((await call('GET', '/api/drives/ghost/conflicts')).statusCode).toBe(404);
    expect((await call('DELETE', `/api/drives/${a.id}/conflicts/${b.id}`)).statusCode).toBe(404);
    expect((await post(a.id, { otherDriveId: b.id })).statusCode).toBe(201);
    expect((await post(b.id, { otherDriveId: a.id })).statusCode).toBe(409);
    // N1: a write without a JSON content type is refused like every other write.
    expect(
      (await app.inject({ method: 'DELETE', url: `/api/drives/${a.id}/conflicts/${b.id}` }))
        .statusCode,
    ).toBe(415);
  });

  it('R78: the pair reaches both drives histories and the recent feed as one activity', async () => {
    const a = drive('WD-A');
    const b = drive('WD-B');
    await call('POST', `/api/drives/${a.id}/conflicts`, { otherDriveId: b.id });
    for (const id of [a.id, b.id]) {
      const history = (await call('GET', `/api/drives/${id}/history`)).json() as {
        kind: string;
        events: unknown[];
      }[];
      expect(history.filter((x) => x.kind === 'conflict-added')).toHaveLength(1);
      expect(history.find((x) => x.kind === 'conflict-added')!.events).toHaveLength(2);
    }
    const recent = (await call('GET', '/api/activities/recent?limit=5')).json() as {
      kind: string;
    }[];
    expect(recent.filter((x) => x.kind === 'conflict-added')).toHaveLength(1);
  });

  it('R78: events of the log are real rows (the type check accepts the new values)', () => {
    const a = drive('WD-A');
    const b = drive('WD-B');
    addConflict(db(), a.id, { otherDriveId: b.id });
    expect(
      db()
        .select()
        .from(events)
        .all()
        .filter((e) => e.type === 'conflict-added'),
    ).toHaveLength(2);
    expect(exportData(db()).data.driveConflicts).toHaveLength(1);
  });
});
