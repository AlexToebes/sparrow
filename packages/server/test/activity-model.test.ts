import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Activity, Observation } from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { listPoolActivities, recordActivity } from '../src/core/activities.js';
import { assignDrive, getAssignmentDefaults, removeToSpares } from '../src/core/assignment.js';
import { createDrive } from '../src/core/drives.js';
import { recordHealthChanges } from '../src/core/health-history.js';
import { createFromObservation, linkObservation } from '../src/core/inbox.js';
import { createLayoutService } from '../src/core/layout.js';
import { changeMembership, joinPool, leavePool } from '../src/core/memberships.js';
import { moveDrive } from '../src/core/move.js';
import { createPool, deletePool, updatePool } from '../src/core/pools.js';
import { dismissSuggestions } from '../src/core/suggestions.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories } from '../src/db/repositories.js';
import { activities, events } from '../src/db/schema.js';
import {
  activitiesOf,
  byDrive,
  countActivities,
  eventsOfDrive,
  lastActivity,
  ofType,
} from './activity-helpers.js';

// R14, R74, R75 (changed 2026-10-12): the history is a log of activities, each a group of atomic
// events (at most one drive, one slot and one pool each) that happened together.

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
const db = () => opened.db;

function bays(): { slots: string[]; gridId: string } {
  const layout = createLayoutService(db());
  const enclosure = layout.createEnclosure({ name: 'NAS' });
  const grid = layout.createGrid(enclosure.id, {
    name: 'Front',
    rows: 1,
    columns: 4,
    orientation: 'landscape',
  });
  return {
    gridId: grid.id,
    slots: layout.getLayout().enclosures[0]!.grids[0]!.slots.map((s) => s.id),
  };
}
const spare = (serial: string) => createDrive(db(), { serial, capacityBytes: 8e12 });
const counts = () => ({
  activities: db().select().from(activities).all().length,
  events: db().select().from(events).all().length,
});
const observation = (serial: string, extra: Partial<Observation> = {}): Observation => ({
  serial,
  health: 'ok',
  lastReportedAt: '2026-03-04T05:06:07.000Z',
  state: 'active',
  ...extra,
});
const snapshot = (observations: Observation[]) =>
  createRepositories(db()).snapshot.put({
    providerId: 'fake',
    observations,
    lastSuccessAt: '2026-03-04T05:06:07.000Z',
    lastAttemptAt: '2026-03-04T05:06:07.000Z',
  });

describe('recordActivity writes the activity and its events together', () => {
  it('R14: inserts the activity with its date and note, and each event with its drive, bay snapshot and pool name', () => {
    const { slots, gridId } = bays();
    const pool = createPool(db(), { name: 'tank' });
    const a = spare('A');
    const before = countActivities(db());
    const stored = db().transaction((tx) =>
      recordActivity(tx, {
        kind: 'assigned',
        occurredOn: '2026-01-02',
        note: 'by hand',
        events: [
          {
            type: 'drive-installed',
            driveId: a.id,
            slotId: slots[1]!,
            poolId: pool.id,
            payload: { poolRole: 'data' },
          },
        ],
      }),
    );
    expect(stored).toMatchObject({ kind: 'assigned', occurredOn: '2026-01-02', note: 'by hand' });
    expect(stored.seq).toBe(before + 1);
    expect(stored.events).toEqual([
      expect.objectContaining({
        ord: 0,
        driveId: a.id,
        slotId: slots[1],
        slotLabel: 'Slot 2',
        gridId,
        gridName: 'Front',
        poolId: pool.id,
        poolName: 'tank',
      }),
    ]);
    expect(listPoolActivities(db(), pool.id).map((x) => x.id)).toContain(stored.id);
  });

  it('R14: omitted date and note are null; seq goes up by one each time; events are numbered in order', () => {
    const a = spare('A');
    const write = () =>
      db().transaction((tx) =>
        recordActivity(tx, {
          kind: 'drive-edited',
          events: [
            { type: 'drive-updated', driveId: a.id, payload: {} },
            { type: 'drive-updated', driveId: a.id, payload: {} },
          ],
        }),
      );
    const first = write();
    const second = write();
    expect(first).toMatchObject({ occurredOn: null, note: null });
    expect(second.seq).toBe(first.seq + 1);
    expect(second.events.map((e) => e.ord)).toEqual([0, 1]);
  });

  it('R14: an activity needs at least one event', () => {
    expect(() =>
      db().transaction((tx) => recordActivity(tx, { kind: 'drive-edited', events: [] })),
    ).toThrow(/needs an event/);
  });

  it('R14: a link to a missing slot or pool fails and leaves no activity behind', () => {
    const before = counts();
    expect(() =>
      db().transaction((tx) =>
        recordActivity(tx, {
          kind: 'layout-updated',
          events: [{ type: 'slot-relabeled', slotId: 'nope', payload: {} }],
        }),
      ),
    ).toThrow(/slot nope/);
    expect(() =>
      db().transaction((tx) =>
        recordActivity(tx, {
          kind: 'pool-edited',
          events: [{ type: 'pool-updated', poolId: 'nope', payload: {} }],
        }),
      ),
    ).toThrow(/pool nope/);
    expect(counts()).toEqual(before);
  });

  it('R14: a deleted slot or pool can still be named with explicit snapshots', () => {
    const stored = db().transaction((tx) =>
      recordActivity(tx, {
        kind: 'pool-edited',
        events: [
          {
            type: 'pool-deleted',
            poolId: 'gone',
            poolName: 'old',
            slotId: 'gone-slot',
            slotSnapshot: { label: 'Bay 9', gridId: 'g', gridName: 'Old grid' },
            payload: {},
          },
        ],
      }),
    );
    expect(stored.events[0]).toMatchObject({
      poolId: 'gone',
      poolName: 'old',
      slotLabel: 'Bay 9',
      gridName: 'Old grid',
    });
  });

  it('R14: an event row that violates the schema rolls the whole activity back', () => {
    const a = spare('A');
    const before = counts();
    expect(() =>
      db().transaction((tx) =>
        recordActivity(tx, {
          kind: 'drive-edited',
          events: [
            { type: 'drive-updated', driveId: a.id, payload: {} },
            { type: 'bogus' as 'drive-updated', driveId: a.id, payload: {} },
          ],
        }),
      ),
    ).toThrow();
    expect(() =>
      db().transaction((tx) =>
        recordActivity(tx, {
          kind: 'drive-edited',
          events: [{ type: 'drive-updated', driveId: 'no-such-drive', payload: {} }],
        }),
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(counts()).toEqual(before);
  });

  it('deleting an activity removes its events (ON DELETE CASCADE)', () => {
    const { slots } = bays();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    db().delete(activities).run();
    expect(counts()).toEqual({ activities: 0, events: 0 });
  });
});

describe('every state change is one activity with the right events', () => {
  it('R14: drive created and updated link the drive only', () => {
    const a = spare('A');
    const created = ofType(lastActivity(db()), 'drive-created')[0]!;
    expect(created).toMatchObject({ driveId: a.id, slotId: null, poolId: null });
    expect(lastActivity(db()).kind).toBe('drive-added');
  });

  it('R22, R23, R14: linking an inbox entry into an occupied bay is ONE discovered-linked activity: linked, outgoing uninstalled and retired, incoming installed', () => {
    const { slots } = bays();
    const holder = spare('HOLD');
    assignDrive(db(), { driveId: holder.id, slotId: slots[0]!, installedOn: '2024-01-01' });
    const sp = spare('SP1');
    snapshot([observation('SP1', { model: 'M' })]);
    linkObservation(db(), 'fake', 'SP1', {
      driveId: sp.id,
      slotId: slots[0]!,
      occupant: { action: 'retire', reason: 'replaced' },
      installedOn: '2026-02-02',
    });
    const act = lastActivity(db());
    expect(act).toMatchObject({ kind: 'discovered-linked', occurredOn: '2026-02-02' });
    expect(byDrive(act)).toEqual([
      [sp.id, 'drive-linked'],
      [holder.id, 'drive-uninstalled'],
      [holder.id, 'drive-retired'],
      [sp.id, 'drive-installed'],
    ]);
    expect(act.events[0]!.payload).toMatchObject({ observationSerial: 'SP1' });
    expect(eventsOfDrive(db(), sp.id).map((e) => e.type)).toEqual([
      'drive-installed',
      'drive-linked',
      'drive-created',
    ]);
  });

  it('R22, R23, R14: creating a record from an observation into an occupied bay is one discovered-created activity', () => {
    const { slots } = bays();
    const holder = spare('HOLD');
    assignDrive(db(), { driveId: holder.id, slotId: slots[0]! });
    snapshot([observation('NEW1')]);
    const { drive } = createFromObservation(db(), 'fake', 'NEW1', {
      slotId: slots[0]!,
      occupant: { action: 'spare' },
    });
    const act = lastActivity(db());
    expect(act.kind).toBe('discovered-created');
    expect(byDrive(act)).toEqual([
      [drive.id, 'drive-created'],
      [holder.id, 'drive-uninstalled'],
      [drive.id, 'drive-installed'],
    ]);
  });

  it('R29, R33: join, role change and leave are three activities, each with one event for the drive, bay and pool', () => {
    const { slots } = bays();
    const pool = createPool(db(), { name: 'tank' });
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const before = countActivities(db());
    joinPool(db(), a.id, { poolId: pool.id });
    changeMembership(db(), a.id, { role: 'hot-spare' });
    leavePool(db(), a.id);
    expect(countActivities(db())).toBe(before + 3);
    expect(
      activitiesOf(db())
        .slice(-3)
        .map((x) => x.kind),
    ).toEqual(['pool-joined', 'pool-role-changed', 'pool-left']);
    for (const type of ['pool-joined', 'pool-role-changed', 'pool-left'] as const) {
      const e = eventsOfDrive(db(), a.id).find((x) => x.type === type)!;
      expect(e).toMatchObject({ driveId: a.id, slotId: slots[0], poolId: pool.id });
    }
  });

  it('R20: health-changed links its drive, in a health-polled activity', () => {
    const a = spare('A');
    recordHealthChanges(
      db(),
      [observation('A', { health: 'warning', lastReportedAt: '2026-03-04T00:00:00.000Z' })],
      '2026-03-05T00:00:00.000Z',
    );
    expect(lastActivity(db()).kind).toBe('health-polled');
    expect(ofType(lastActivity(db()), 'health-changed')[0]).toMatchObject({ driveId: a.id });
  });

  it('R72: suggestion-dismissed links its drive', () => {
    const a = spare('A');
    snapshot([observation('A', { model: 'M' })]);
    dismissSuggestions(db(), 'fake', a.id, ['model']);
    expect(ofType(lastActivity(db()), 'suggestion-dismissed')[0]).toMatchObject({
      driveId: a.id,
    });
  });

  it('R39: a relabel links the bay and keeps no drive', () => {
    const { slots } = bays();
    createLayoutService(db()).updateSlotLabel(slots[0]!, { label: 'Top' });
    const act = lastActivity(db());
    expect(act.kind).toBe('layout-updated');
    expect(act.events[0]).toMatchObject({
      type: 'slot-relabeled',
      slotId: slots[0],
      slotLabel: 'Top',
      driveId: null,
    });
  });

  it('R14: one real action never writes two activities (assign into an occupied bay, move with a spare, swap)', () => {
    const { slots } = bays();
    const [a, b, c, d] = [spare('A'), spare('B'), spare('C'), spare('D')] as const;
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    assignDrive(db(), { driveId: b.id, slotId: slots[1]! });
    const n = countActivities(db());
    assignDrive(db(), { driveId: c.id, slotId: slots[0]!, occupant: { action: 'spare' } });
    moveDrive(db(), b.id, {
      destination: { kind: 'slot', slotId: slots[2]! },
      replacement: { driveId: d.id },
    });
    moveDrive(db(), c.id, {
      destination: { kind: 'slot', slotId: slots[2]!, occupant: { action: 'swap' } },
    });
    expect(countActivities(db())).toBe(n + 3);
    expect(
      activitiesOf(db())
        .slice(-3)
        .map((x) => x.kind),
    ).toEqual(['replaced', 'moved', 'swapped']);
  });
});

describe('R35: the last occupant is read from the log', () => {
  it('after a replacement the newcomer is the previous occupant (pool and role included)', () => {
    const { slots } = bays();
    const pool = createPool(db(), { name: 'tank' });
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool.id, role: 'hot-spare' });
    assignDrive(db(), {
      driveId: b.id,
      slotId: slots[0]!,
      occupant: { action: 'spare' },
    });
    removeToSpares(db(), b.id);
    expect(getAssignmentDefaults(db(), slots[0]!)).toEqual({
      poolId: pool.id,
      role: 'hot-spare',
      previousDriveId: b.id,
    });
  });

  it('after a move the old bay remembers the mover and the new bay too', () => {
    const { slots } = bays();
    const pool = createPool(db(), { name: 'tank' });
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool.id });
    moveDrive(db(), a.id, { destination: { kind: 'slot', slotId: slots[2]! } });
    // Bay 3 now holds A, whose pool went along.
    expect(getAssignmentDefaults(db(), slots[2]!)).toMatchObject({
      poolId: pool.id,
      previousDriveId: a.id,
    });
    removeToSpares(db(), a.id);
    expect(getAssignmentDefaults(db(), slots[0]!)).toMatchObject({
      poolId: pool.id,
      previousDriveId: a.id,
    });
  });

  it('after a swap each bay remembers the drive that arrived', () => {
    const { slots } = bays();
    const pool = createPool(db(), { name: 'tank' });
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool.id, role: 'data' });
    assignDrive(db(), { driveId: b.id, slotId: slots[1]!, poolId: pool.id, role: 'hot-spare' });
    moveDrive(db(), a.id, {
      destination: { kind: 'slot', slotId: slots[1]!, occupant: { action: 'swap' } },
    });
    removeToSpares(db(), a.id); // A left bay 2
    removeToSpares(db(), b.id); // B left bay 1
    expect(getAssignmentDefaults(db(), slots[0]!)).toMatchObject({
      previousDriveId: b.id,
      role: 'hot-spare',
    });
    expect(getAssignmentDefaults(db(), slots[1]!)).toMatchObject({
      previousDriveId: a.id,
      role: 'data',
    });
  });

  it('a deleted pool is not offered as a default', () => {
    const { slots } = bays();
    const pool = createPool(db(), { name: 'tank' });
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool.id });
    removeToSpares(db(), a.id);
    deletePool(db(), pool.id);
    expect(getAssignmentDefaults(db(), slots[0]!)).toEqual({
      poolId: null,
      role: null,
      previousDriveId: a.id,
    });
  });
});

describe('histories group events by activity', () => {
  it('R75: GET /api/pools/:id/history lists the activities with an event on the pool, each with all its events, newest first', async () => {
    const { slots } = bays();
    const pool = createPool(db(), { name: 'tank' });
    const other = createPool(db(), { name: 'scratch' });
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool.id });
    changeMembership(db(), a.id, { role: 'hot-spare' });
    updatePool(db(), pool.id, { name: 'vault' });
    leavePool(db(), a.id);
    const res = await app.inject({ method: 'GET', url: `/api/pools/${pool.id}/history` });
    expect(res.statusCode).toBe(200);
    const body = res.json() as Activity[];
    expect(body.map((x) => x.kind)).toEqual([
      'pool-left',
      'pool-edited',
      'pool-role-changed',
      'assigned',
      'pool-edited',
    ]);
    // Newest first by seq, not by timestamp.
    expect(body.map((x) => x.seq)).toEqual([...body.map((x) => x.seq)].sort((x, y) => y - x));
    // The event lists the member by serial; the pool name is the one at the time of the event.
    expect(body[0]!.events[0]!.drive).toEqual({
      serial: 'A',
      capacityBytes: 8e12,
      driveType: null,
    });
    expect(body.map((x) => x.events[0]!.poolName)).toEqual([
      'vault',
      'vault',
      'tank',
      'tank',
      'tank',
    ]);
    // The other pool's history is not mixed in.
    expect(listPoolActivities(db(), other.id).map((x) => x.kind)).toEqual(['pool-edited']);
    const missing = await app.inject({ method: 'GET', url: '/api/pools/nope/history' });
    expect(missing.statusCode).toBe(404);
  });

  it('R75: a deleted pool keeps its events, with the name copied', () => {
    const pool = createPool(db(), { name: 'gone' });
    deletePool(db(), pool.id);
    const hist = listPoolActivities(db(), pool.id);
    expect(hist.flatMap((x) => x.events.map((e) => e.type))).toEqual([
      'pool-deleted',
      'pool-created',
    ]);
    expect(hist[0]!.events[0]).toMatchObject({ poolId: pool.id, poolName: 'gone' });
  });

  it('R14: GET /api/drives/:id/history returns the activities with ALL their events, other drives included', async () => {
    const { slots } = bays();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2023-01-01' });
    assignDrive(db(), { driveId: b.id, slotId: slots[0]!, occupant: { action: 'spare' } });
    const res = await app.inject({ method: 'GET', url: `/api/drives/${a.id}/history` });
    const body = res.json() as Activity[];
    expect(body.map((x) => x.kind)).toEqual(['replaced', 'assigned', 'drive-added']);
    // A's history shows the whole replacement, including the drive that took its place.
    expect(body[0]!.events.map((e) => [e.type, e.drive!.serial])).toEqual([
      ['drive-uninstalled', 'A'],
      ['drive-installed', 'B'],
    ]);
    expect(body[0]!.events[0]).toMatchObject({
      slotId: slots[0],
      slotLabel: 'Slot 1',
      gridName: 'Front',
    });
    expect((await app.inject({ method: 'GET', url: '/api/drives/nope/history' })).statusCode).toBe(
      404,
    );
    // The old endpoints are gone.
    expect(
      (await app.inject({ method: 'GET', url: `/api/drives/${a.id}/events` })).statusCode,
    ).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/events/recent' })).statusCode).toBe(404);
  });

  it('R75: /api/activities/recent returns activities with their events, newest first, limited', async () => {
    const { slots } = bays();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const res = await app.inject({ method: 'GET', url: '/api/activities/recent?limit=2' });
    const body = res.json() as Activity[];
    expect(body).toHaveLength(2);
    expect(body[0]!.kind).toBe('assigned');
    expect(body[0]!.events[0]).toMatchObject({ type: 'drive-installed', slotLabel: 'Slot 1' });
    expect(body[0]!.events[0]!.drive).toMatchObject({ serial: 'A' });
    expect(body[1]!.kind).toBe('drive-added');
    expect(
      (await app.inject({ method: 'GET', url: '/api/activities/recent?limit=0' })).statusCode,
    ).toBe(400);
  });

  it('R75: /api/activities/recent pages with an exclusive before=<seq> cursor', async () => {
    const { slots } = bays();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const first = (
      await app.inject({ method: 'GET', url: '/api/activities/recent?limit=1' })
    ).json() as Activity[];
    expect(first[0]!.kind).toBe('assigned');
    const next = (
      await app.inject({
        method: 'GET',
        url: `/api/activities/recent?limit=1&before=${first[0]!.seq}`,
      })
    ).json() as Activity[];
    expect(next).toHaveLength(1);
    expect(next[0]!.seq).toBeLessThan(first[0]!.seq);
    expect(next[0]!.kind).toBe('drive-added');
    const none = (
      await app.inject({ method: 'GET', url: '/api/activities/recent?before=1' })
    ).json() as Activity[];
    expect(none).toEqual([]);
    for (const bad of ['before=0', 'before=abc', 'before=1.5']) {
      expect(
        (await app.inject({ method: 'GET', url: `/api/activities/recent?${bad}` })).statusCode,
      ).toBe(400);
    }
  });
});

describe('table constraints (schema)', () => {
  const insertActivity = (id: string, seq: number, kind = 'swapped') =>
    opened.sqlite
      .prepare('INSERT INTO activities (id, seq, kind, recorded_at) VALUES (?, ?, ?, ?)')
      .run(id, seq, kind, '2026-01-01T00:00:00.000Z');

  it('seq is unique, the kind is checked', () => {
    insertActivity('a1', 1);
    expect(() => insertActivity('a2', 1)).toThrow(/UNIQUE/);
    expect(() => insertActivity('a3', 3, 'exploded')).toThrow(/CHECK/);
  });

  it('an event needs an activity and a known type; a drive link needs a real drive', () => {
    insertActivity('a1', 1);
    const d = spare('A');
    const ins = (id: string, activity: string, type: string, drive: string | null) =>
      opened.sqlite
        .prepare(
          "INSERT INTO events (id, activity_id, ord, type, drive_id, payload) VALUES (?, ?, 0, ?, ?, '{}')",
        )
        .run(id, activity, type, drive);
    ins('e1', 'a1', 'drive-installed', d.id);
    expect(() => ins('e2', 'no-activity', 'drive-installed', d.id)).toThrow(/FOREIGN KEY/);
    expect(() => ins('e3', 'a1', 'drive-moved', d.id)).toThrow(/CHECK/);
    expect(() => ins('e4', 'a1', 'drive-installed', 'no-such-drive')).toThrow(/FOREIGN KEY/);
  });

  it('slot and pool columns need no slot or pool row (history survives deletion)', () => {
    insertActivity('a1', 1);
    opened.sqlite
      .prepare(
        "INSERT INTO events (id, activity_id, ord, type, slot_id, slot_label, grid_id, grid_name, pool_id, pool_name, payload) VALUES ('e1', 'a1', 0, 'drive-installed', 'gone', NULL, 'g', 'Old grid', 'gone-pool', 'old', '{}')",
      )
      .run();
    expect(counts().events).toBe(1);
  });
});
