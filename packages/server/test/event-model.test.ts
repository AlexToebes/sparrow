import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { DriveEvent, Observation } from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { assignDrive, getAssignmentDefaults, removeToSpares } from '../src/core/assignment.js';
import { createDrive } from '../src/core/drives.js';
import {
  listDriveEvents,
  listPoolEvents,
  listRecentEvents,
  recordEvent,
} from '../src/core/events.js';
import { recordHealthChanges } from '../src/core/health-history.js';
import { createFromObservation, linkObservation } from '../src/core/inbox.js';
import { createLayoutService } from '../src/core/layout.js';
import { changeMembership, joinPool, leavePool } from '../src/core/memberships.js';
import { moveDrive } from '../src/core/move.js';
import { createPool, deletePool, updatePool } from '../src/core/pools.js';
import { dismissSuggestions } from '../src/core/suggestions.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories } from '../src/db/repositories.js';
import { eventDrives, eventPools, events, eventSlots } from '../src/db/schema.js';
import { driveLinks, poolLinks, slotLinks, subject } from './event-helpers.js';

// R14, R74, R75 (changed 2026-10-11): one event per real action, linked to every drive, slot and pool.

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
const ofType = (driveId: string, type: string): DriveEvent[] =>
  listDriveEvents(db(), driveId).filter((e) => e.type === type);
const linkCounts = () => ({
  events: db().select().from(events).all().length,
  drives: db().select().from(eventDrives).all().length,
  slots: db().select().from(eventSlots).all().length,
  pools: db().select().from(eventPools).all().length,
});

describe('recordEvent writes the event and its links together', () => {
  it('R14: inserts the event with drive roles, slot snapshots and pool names', () => {
    const { slots, gridId } = bays();
    const pool = createPool(db(), { name: 'tank' });
    const a = spare('A');
    const b = spare('B');
    const stored = db().transaction((tx) =>
      recordEvent(tx, {
        type: 'drive-replaced',
        payload: { x: 1 },
        drives: [
          { id: a.id, role: 'outgoing' },
          { id: b.id, role: 'incoming' },
        ],
        slots: [{ id: slots[1]!, role: 'at' }],
        pools: [{ id: pool.id }],
      }),
    );
    expect(stored.links.drives).toEqual([
      { driveId: a.id, role: 'outgoing' },
      { driveId: b.id, role: 'incoming' },
    ]);
    expect(stored.links.slots).toEqual([
      { slotId: slots[1], role: 'at', slotLabel: 'Slot 2', gridId, gridName: 'Front' },
    ]);
    expect(stored.links.pools).toEqual([{ poolId: pool.id, poolName: 'tank' }]);
    expect(listPoolEvents(db(), pool.id).map((e) => e.id)).toContain(stored.id);
  });

  it('R14: the drive role defaults to subject; a repeated link is written once', () => {
    const a = spare('A');
    const stored = db().transaction((tx) =>
      recordEvent(tx, {
        type: 'drive-updated',
        payload: {},
        drives: [{ id: a.id }, { id: a.id }],
      }),
    );
    expect(stored.links.drives).toEqual([{ driveId: a.id, role: 'subject' }]);
  });

  it('R14: a link to a missing slot or pool fails and leaves no event behind', () => {
    const before = linkCounts();
    expect(() =>
      db().transaction((tx) =>
        recordEvent(tx, {
          type: 'slot-relabeled',
          payload: {},
          slots: [{ id: 'nope', role: 'at' }],
        }),
      ),
    ).toThrow(/slot nope/);
    expect(() =>
      db().transaction((tx) =>
        recordEvent(tx, { type: 'pool-updated', payload: {}, pools: [{ id: 'nope' }] }),
      ),
    ).toThrow(/pool nope/);
    expect(linkCounts()).toEqual(before);
  });

  it('R14: a link row that violates the schema rolls the whole event back', () => {
    const a = spare('A');
    const before = linkCounts();
    expect(() =>
      db().transaction((tx) =>
        recordEvent(tx, {
          type: 'drive-updated',
          payload: {},
          drives: [{ id: a.id, role: 'bogus' as 'subject' }],
        }),
      ),
    ).toThrow();
    expect(() =>
      db().transaction((tx) =>
        recordEvent(tx, { type: 'drive-updated', payload: {}, drives: [{ id: 'no-such-drive' }] }),
      ),
    ).toThrow(/FOREIGN KEY/);
    expect(linkCounts()).toEqual(before);
  });

  it('deleting an event removes its links (ON DELETE CASCADE)', () => {
    const { slots } = bays();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    db().delete(events).run();
    expect(linkCounts()).toEqual({ events: 0, drives: 0, slots: 0, pools: 0 });
  });
});

describe('every state change is one event with the right links', () => {
  it('R14: drive created and updated link the drive only', () => {
    const a = spare('A');
    expect(driveLinks(ofType(a.id, 'drive-created')[0]!)).toEqual(subject(a.id));
    expect(ofType(a.id, 'drive-created')[0]!.links.slots).toEqual([]);
  });

  it('R22, R23, R14: linking an inbox entry into an occupied bay writes drive-linked, then ONE drive-replaced', () => {
    const { slots } = bays();
    const holder = spare('HOLD');
    assignDrive(db(), { driveId: holder.id, slotId: slots[0]!, installedOn: '2024-01-01' });
    const sp = spare('SP1');
    createRepositories(db()).snapshot.put({
      providerId: 'fake',
      observations: [
        {
          serial: 'SP1',
          health: 'ok',
          lastReportedAt: '2026-03-04T05:06:07.000Z',
          state: 'active',
          model: 'M',
        },
      ] satisfies Observation[],
      lastSuccessAt: '2026-03-04T05:06:07.000Z',
      lastAttemptAt: '2026-03-04T05:06:07.000Z',
    });
    linkObservation(db(), 'fake', 'SP1', {
      driveId: sp.id,
      slotId: slots[0]!,
      occupant: { action: 'retire', reason: 'replaced', date: '2026-02-02' },
    });
    expect(listDriveEvents(db(), sp.id).map((e) => e.type)).toEqual([
      'drive-replaced',
      'drive-linked',
      'drive-created',
    ]);
    const replaced = ofType(sp.id, 'drive-replaced')[0]!;
    expect(driveLinks(replaced)).toEqual([
      { driveId: sp.id, role: 'incoming' },
      { driveId: holder.id, role: 'outgoing' },
    ]);
    expect(slotLinks(replaced)).toEqual([{ slotId: slots[0], role: 'at' }]);
    expect(replaced.payload).toMatchObject({
      installedOn: null, // R68: a drive found in the NAS has no recorded installation date
      outgoing: { outcome: 'retired', reason: 'replaced', date: '2026-02-02' },
    });
    expect(driveLinks(ofType(sp.id, 'drive-linked')[0]!)).toEqual(subject(sp.id));
    expect(ofType(holder.id, 'drive-retired')).toHaveLength(0);
  });

  it('R22, R23, R14: creating a record from an observation into an occupied bay is one drive-replaced', () => {
    const { slots } = bays();
    const holder = spare('HOLD');
    assignDrive(db(), { driveId: holder.id, slotId: slots[0]! });
    createRepositories(db()).snapshot.put({
      providerId: 'fake',
      observations: [
        {
          serial: 'NEW1',
          health: 'ok',
          lastReportedAt: '2026-03-04T05:06:07.000Z',
          state: 'active',
        },
      ] satisfies Observation[],
      lastSuccessAt: '2026-03-04T05:06:07.000Z',
      lastAttemptAt: '2026-03-04T05:06:07.000Z',
    });
    const { drive } = createFromObservation(db(), 'fake', 'NEW1', {
      slotId: slots[0]!,
      occupant: { action: 'spare' },
    });
    expect(listDriveEvents(db(), drive.id).map((e) => e.type)).toEqual([
      'drive-replaced',
      'drive-created',
    ]);
    expect(driveLinks(ofType(drive.id, 'drive-replaced')[0]!)).toEqual([
      { driveId: drive.id, role: 'incoming' },
      { driveId: holder.id, role: 'outgoing' },
    ]);
  });

  it('R29, R33: join, role change and leave link the drive and the pool', () => {
    const { slots } = bays();
    const pool = createPool(db(), { name: 'tank' });
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    joinPool(db(), a.id, { poolId: pool.id });
    changeMembership(db(), a.id, { role: 'hot-spare' });
    leavePool(db(), a.id);
    for (const type of ['pool-joined', 'pool-role-changed', 'pool-left']) {
      const e = ofType(a.id, type)[0]!;
      expect(driveLinks(e)).toEqual(subject(a.id));
      expect(poolLinks(e)).toEqual([pool.id]);
      expect(e.links.slots).toEqual([]);
    }
  });

  it('R20: health-changed links its drive', () => {
    const a = spare('A');
    recordHealthChanges(
      db(),
      [
        {
          serial: 'A',
          health: 'warning',
          lastReportedAt: '2026-03-04T00:00:00.000Z',
          state: 'active',
        },
      ],
      '2026-03-05T00:00:00.000Z',
    );
    expect(driveLinks(ofType(a.id, 'health-changed')[0]!)).toEqual(subject(a.id));
  });

  it('R72: suggestion-dismissed links its drive', () => {
    const a = spare('A');
    createRepositories(db()).snapshot.put({
      providerId: 'fake',
      observations: [
        {
          serial: 'A',
          health: 'ok',
          lastReportedAt: '2026-03-04T05:06:07.000Z',
          state: 'active',
          model: 'M',
        },
      ] satisfies Observation[],
      lastSuccessAt: '2026-03-04T05:06:07.000Z',
      lastAttemptAt: '2026-03-04T05:06:07.000Z',
    });
    dismissSuggestions(db(), 'fake', a.id, ['model']);
    expect(driveLinks(ofType(a.id, 'suggestion-dismissed')[0]!)).toEqual(subject(a.id));
  });

  it('R39: a relabel links the bay (at) and keeps no drive link', () => {
    const { slots } = bays();
    createLayoutService(db()).updateSlotLabel(slots[0]!, { label: 'Top' });
    const e = listRecentEvents(db(), 1)[0]!;
    expect(e.type).toBe('slot-relabeled');
    expect(slotLinks(e)).toEqual([{ slotId: slots[0], role: 'at' }]);
    expect(e.links.drives).toEqual([]);
  });
});

describe('R35: the last occupant is read from the slot links', () => {
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
    // Bay 3 now holds A, whose membership went along.
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
});

describe('histories read the link tables', () => {
  it('R75: GET /api/pools/:id/history lists the pool record and member events, newest first', async () => {
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
    const body = res.json() as DriveEvent[];
    expect(body.map((e) => e.type)).toEqual([
      'pool-left',
      'pool-updated',
      'pool-role-changed',
      'pool-joined',
      'pool-created',
    ]);
    // The event lists the member by serial; the pool name is the one at the time of the event.
    expect(body[0]!.links.drives).toEqual([
      { driveId: a.id, role: 'subject', serial: 'A', capacityBytes: 8e12, driveType: null },
    ]);
    expect(body.map((e) => e.links.pools[0]!.poolName)).toEqual([
      'vault',
      'vault',
      'tank',
      'tank',
      'tank',
    ]);
    // The other pool's history is not mixed in.
    expect(listPoolEvents(db(), other.id).map((e) => e.type)).toEqual(['pool-created']);
    const missing = await app.inject({ method: 'GET', url: '/api/pools/nope/history' });
    expect(missing.statusCode).toBe(404);
  });

  it('R75: a deleted pool keeps its events, with the name copied', () => {
    const pool = createPool(db(), { name: 'gone' });
    deletePool(db(), pool.id);
    const hist = listPoolEvents(db(), pool.id);
    expect(hist.map((e) => e.type)).toEqual(['pool-deleted', 'pool-created']);
    expect(hist[0]!.links.pools).toEqual([{ poolId: pool.id, poolName: 'gone' }]);
  });

  it('R14: GET /api/drives/:id/events returns the events with all their links, other drives included', async () => {
    const { slots } = bays();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2023-01-01' });
    assignDrive(db(), { driveId: b.id, slotId: slots[0]!, occupant: { action: 'spare' } });
    const res = await app.inject({ method: 'GET', url: `/api/drives/${a.id}/events` });
    const body = res.json() as DriveEvent[];
    expect(body.map((e) => e.type)).toEqual(['drive-replaced', 'drive-installed', 'drive-created']);
    expect(body[0]!.links.drives.map((d) => [d.role, d.serial])).toEqual([
      ['outgoing', 'A'],
      ['incoming', 'B'],
    ]);
    expect(body[0]!.links.slots).toEqual([
      {
        slotId: slots[0],
        role: 'at',
        slotLabel: 'Slot 1',
        gridId: expect.any(String),
        gridName: 'Front',
      },
    ]);
  });

  it('R75: /api/events/recent includes pool names and slot labels', async () => {
    const { slots } = bays();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const res = await app.inject({ method: 'GET', url: '/api/events/recent?limit=2' });
    const body = res.json() as DriveEvent[];
    expect(body[0]!.type).toBe('drive-installed');
    expect(body[0]!.links.slots[0]).toMatchObject({ role: 'to', slotLabel: 'Slot 1' });
    expect(body[0]!.links.drives[0]).toMatchObject({ serial: 'A', role: 'subject' });
  });

  it('R14: a drive appears in the history of events another drive caused (the replaced one)', () => {
    const { slots } = bays();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    assignDrive(db(), { driveId: b.id, slotId: slots[0]!, occupant: { action: 'spare' } });
    const inA = ofType(a.id, 'drive-replaced')[0]!;
    const inB = ofType(b.id, 'drive-replaced')[0]!;
    expect(inA.id).toBe(inB.id);
    expect(
      db().select().from(eventDrives).where(eq(eventDrives.eventId, inA.id)).all(),
    ).toHaveLength(2);
  });
});

describe('link table constraints (schema)', () => {
  const insertEvent = (id: string) =>
    opened.sqlite
      .prepare("INSERT INTO events (id, type, at, payload) VALUES (?, 'drives-swapped', ?, '{}')")
      .run(id, '2026-01-01T00:00:00.000Z');

  it('a slot may be linked twice to one event with different roles (swap), not with the same role', () => {
    insertEvent('e1');
    const link = opened.sqlite.prepare(
      "INSERT INTO event_slots (event_id, slot_id, role, slot_label, grid_id, grid_name) VALUES ('e1', 's1', ?, '1', 'g', 'Front')",
    );
    link.run('from');
    link.run('to');
    expect(() => link.run('to')).toThrow(/UNIQUE|PRIMARY/);
  });

  it('roles are checked; a drive can be linked once per event; the drive must exist', () => {
    insertEvent('e1');
    const d = spare('A');
    const ins = opened.sqlite.prepare(
      "INSERT INTO event_drives (event_id, drive_id, role) VALUES ('e1', ?, ?)",
    );
    expect(() => ins.run(d.id, 'bystander')).toThrow(/CHECK/);
    ins.run(d.id, 'subject');
    expect(() => ins.run(d.id, 'incoming')).toThrow(/UNIQUE|PRIMARY/);
    expect(() => ins.run('no-such-drive', 'subject')).toThrow(/FOREIGN KEY/);
    expect(() =>
      opened.sqlite
        .prepare(
          "INSERT INTO event_slots (event_id, slot_id, role, grid_id, grid_name) VALUES ('e1', 's', 'sideways', 'g', 'n')",
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('slot and pool links need no slot or pool row (history survives deletion)', () => {
    insertEvent('e1');
    opened.sqlite
      .prepare(
        "INSERT INTO event_slots (event_id, slot_id, role, slot_label, grid_id, grid_name) VALUES ('e1', 'gone', 'at', NULL, 'g', 'Old grid')",
      )
      .run();
    opened.sqlite
      .prepare(
        "INSERT INTO event_pools (event_id, pool_id, pool_name) VALUES ('e1', 'gone', 'old')",
      )
      .run();
    expect(linkCounts()).toMatchObject({ slots: 1, pools: 1 });
  });
});
