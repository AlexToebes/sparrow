import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import {
  assignDrive,
  getAssignmentDefaults,
  reinstateDrive,
  removeToSpares,
  retireDrive,
  sendForRma,
} from '../src/core/assignment.js';
import { createDrive, getDrive } from '../src/core/drives.js';
import { DomainError } from '../src/core/errors.js';
import { listDriveEvents } from '../src/core/events.js';
import { createLayoutService } from '../src/core/layout.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import {
  drives,
  eventDrives,
  eventPools,
  events,
  eventSlots,
  memberships,
  pools,
} from '../src/db/schema.js';
import { driveLinks, poolLinks, slotLinks, subject } from './event-helpers.js';

let opened: OpenedDatabase;
beforeEach(() => {
  opened = openDatabase(':memory:');
});
afterEach(() => opened.sqlite.close());

const db = () => opened.db;
const TODAY = () => new Date().toISOString().slice(0, 10);

function setup() {
  const layout = createLayoutService(db());
  const enclosure = layout.createEnclosure({ name: 'NAS' });
  const grid = layout.createGrid(enclosure.id, {
    name: 'Front',
    rows: 2,
    columns: 2,
    orientation: 'landscape',
  });
  const slots = layout
    .getLayout()
    .enclosures.flatMap((e) => e.grids)
    .find((g) => g.id === grid.id)!.slots;
  return { slots: slots.map((s) => s.id), grid };
}

function makePool(name: string): string {
  const at = new Date().toISOString();
  const id = `pool-${name}`;
  db().insert(pools).values({ id, name, layoutLabel: null, createdAt: at, updatedAt: at }).run();
  return id;
}

const spare = (serial: string) => createDrive(db(), { serial });
const types = (id: string) => listDriveEvents(db(), id).map((e) => e.type);
const eventOf = (id: string, type: string) =>
  listDriveEvents(db(), id).find((e) => e.type === type)!;
const memberRows = (driveId: string) =>
  db().select().from(memberships).where(eq(memberships.driveId, driveId)).all();

function thrown(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err;
    throw err;
  }
  throw new Error('expected a DomainError');
}

describe('assign (R8, R35, D7)', () => {
  it('R14, R74: spare -> installed in an empty slot is ONE drive-installed event linked to the drive and the slot (to)', () => {
    const { slots } = setup();
    const d = spare('A');
    const { drive, occupant } = assignDrive(db(), { driveId: d.id, slotId: slots[0]! });
    expect(occupant).toBeUndefined();
    expect(drive).toMatchObject({ status: 'installed', slotId: slots[0] });
    expect(getDrive(db(), d.id)).toEqual(drive);
    expect(types(d.id)).toEqual(['drive-installed', 'drive-created']);
    const installed = eventOf(d.id, 'drive-installed');
    expect(installed.payload).toEqual({ poolId: null, role: null, installedOn: TODAY() });
    expect(driveLinks(installed)).toEqual(subject(d.id));
    // The bay's label and grid are copied into the link, so they survive renames and deletion (R39).
    expect(installed.links.slots).toEqual([
      {
        slotId: slots[0],
        role: 'to',
        slotLabel: 'Slot 1',
        gridId: expect.any(String),
        gridName: 'Front',
      },
    ]);
    expect(installed.links.pools).toEqual([]);
    expect(drive.installedOn).toBe(TODAY());
  });

  it('R35: explicit pool creates a manual membership and pool-joined; role defaults to data', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slots[0]!, poolId: pool });
    const [m] = memberRows(d.id);
    expect(m).toMatchObject({ poolId: pool, role: 'data', source: 'manual', endedAt: null });
    expect(types(d.id)).toEqual(['drive-installed', 'pool-joined', 'drive-created']);
    const joined = eventOf(d.id, 'pool-joined');
    expect(joined.payload).toMatchObject({ role: 'data' });
    expect(poolLinks(joined)).toEqual([pool]);
    expect(driveLinks(joined)).toEqual(subject(d.id));
  });

  it('R8: a retired drive cannot be assigned', () => {
    const { slots } = setup();
    const d = spare('A');
    retireDrive(db(), d.id, { reason: 'failed' });
    const err = thrown(() => assignDrive(db(), { driveId: d.id, slotId: slots[0]! }));
    expect(err.code).toBe('invalid');
    expect(err.message).toBe('Retired drives cannot be assigned');
  });

  it('D7: an installed drive cannot be assigned to a second slot', () => {
    const { slots } = setup();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slots[0]! });
    const err = thrown(() => assignDrive(db(), { driveId: d.id, slotId: slots[1]! }));
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/remove it from its current slot first/);
    expect(getDrive(db(), d.id).slotId).toBe(slots[0]);
  });

  it('unknown drive or slot is not-found', () => {
    const { slots } = setup();
    const d = spare('A');
    expect(thrown(() => assignDrive(db(), { driveId: 'nope', slotId: slots[0]! })).code).toBe(
      'not-found',
    );
    expect(thrown(() => assignDrive(db(), { driveId: d.id, slotId: 'nope' })).code).toBe(
      'not-found',
    );
    expect(
      thrown(() => assignDrive(db(), { driveId: d.id, slotId: slots[0]!, poolId: 'nope' })).code,
    ).toBe('not-found');
  });
});

describe('occupied slot (R37, R62)', () => {
  it('R37: rejects with 409 details naming the occupant and changes nothing', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const err = thrown(() => assignDrive(db(), { driveId: b.id, slotId: slots[0]! }));
    expect(err.code).toBe('conflict');
    expect(err.details).toEqual({ occupant: { driveId: a.id, serial: 'A' } });
    expect(getDrive(db(), a.id).status).toBe('installed');
    expect(getDrive(db(), b.id).status).toBe('spare');
  });

  it('R14, R74: occupant -> spare is ONE drive-replaced event (outgoing + incoming, slot at); no separate removed / installed', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const res = assignDrive(db(), {
      driveId: b.id,
      slotId: slots[0]!,
      occupant: { action: 'spare' },
    });
    expect(res.occupant).toMatchObject({ id: a.id, status: 'spare', slotId: null });
    expect(res.drive).toMatchObject({ id: b.id, status: 'installed', slotId: slots[0] });
    expect(types(a.id)).toEqual(['drive-replaced', 'drive-installed', 'drive-created']);
    expect(types(b.id)).toEqual(['drive-replaced', 'drive-created']);
    const replaced = eventOf(b.id, 'drive-replaced');
    expect(eventOf(a.id, 'drive-replaced').id).toBe(replaced.id);
    expect(driveLinks(replaced)).toEqual([
      { driveId: b.id, role: 'incoming' },
      { driveId: a.id, role: 'outgoing' },
    ]);
    expect(slotLinks(replaced)).toEqual([{ slotId: slots[0], role: 'at' }]);
    expect(replaced.payload).toMatchObject({
      installedOn: TODAY(),
      outgoing: { outcome: 'spares', date: TODAY(), installedOn: TODAY() },
    });
  });

  it("R62: occupant 'retire' keeps the user's reason and date", () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const res = assignDrive(db(), {
      driveId: b.id,
      slotId: slots[0]!,
      occupant: { action: 'retire', reason: 'replaced', date: '2026-01-02', note: 'old' },
    });
    expect(res.occupant).toMatchObject({
      status: 'retired',
      slotId: null,
      retirementReason: 'replaced',
      retirementDate: '2026-01-02',
      retirementNote: 'old',
    });
    expect(types(a.id)).toEqual(['drive-replaced', 'drive-installed', 'drive-created']);
    expect(eventOf(a.id, 'drive-replaced').payload).toMatchObject({
      outgoing: { outcome: 'retired', reason: 'replaced', date: '2026-01-02', note: 'old' },
    });
    expect(getDrive(db(), b.id).status).toBe('installed');
  });

  it('R62: retiring the occupant requires a reason (no preset)', async () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const app = buildApp({ db: db() });
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: `/api/slots/${slots[0]}/assign`,
      payload: { driveId: b.id, occupant: { action: 'retire' } },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
    expect(getDrive(db(), a.id).status).toBe('installed');
  });

  it('R27, R74: occupant rma is the outgoing outcome of the one drive-replaced event', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const res = assignDrive(db(), {
      driveId: b.id,
      slotId: slots[0]!,
      occupant: { action: 'rma', date: '2026-02-03' },
    });
    expect(res.occupant).toMatchObject({
      status: 'retired',
      retirementReason: 'failed',
      retirementDate: '2026-02-03',
    });
    expect(types(a.id)).toEqual(['drive-replaced', 'drive-installed', 'drive-created']);
    expect(eventOf(a.id, 'drive-replaced').payload).toMatchObject({
      outgoing: { outcome: 'rma', date: '2026-02-03' },
    });
  });
});

describe('pool and role defaults (R35)', () => {
  it('incoming drive inherits the resolved occupant pool and role', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool, role: 'hot-spare' });
    assignDrive(db(), {
      driveId: b.id,
      slotId: slots[0]!,
      occupant: { action: 'retire', reason: 'replaced', date: '2026-01-02' },
    });
    expect(memberRows(a.id)[0]!.endedAt).not.toBeNull();
    expect(types(a.id)).toContain('pool-left');
    expect(memberRows(b.id)).toHaveLength(1);
    expect(memberRows(b.id)[0]).toMatchObject({ poolId: pool, role: 'hot-spare', endedAt: null });
    expect(eventOf(b.id, 'drive-replaced').payload).toMatchObject({
      poolId: pool,
      role: 'hot-spare',
    });
  });

  it('defaults come from the last occupant of an emptied slot (getAssignmentDefaults)', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    expect(getAssignmentDefaults(db(), slots[0]!)).toEqual({
      poolId: null,
      role: null,
      previousDriveId: null,
    });
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool, role: 'hot-spare' });
    expect(getAssignmentDefaults(db(), slots[0]!)).toEqual({
      poolId: pool,
      role: 'hot-spare',
      previousDriveId: a.id,
    });
    removeToSpares(db(), a.id);
    const expected = { poolId: pool, role: 'hot-spare', previousDriveId: a.id };
    expect(getAssignmentDefaults(db(), slots[0]!)).toEqual(expected);

    const b = spare('B');
    assignDrive(db(), { driveId: b.id, slotId: slots[0]! });
    expect(memberRows(b.id)[0]).toMatchObject({ poolId: pool, role: 'hot-spare' });
  });

  it('explicit null pool means no pool even when the previous occupant had one', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool });
    removeToSpares(db(), a.id);
    assignDrive(db(), { driveId: b.id, slotId: slots[0]!, poolId: null, role: 'hot-spare' });
    expect(memberRows(b.id)).toHaveLength(0);
    expect(types(b.id)).not.toContain('pool-joined');
    expect(eventOf(b.id, 'drive-installed').payload).toMatchObject({ poolId: null, role: null });
  });

  it('explicit role overrides the previous role', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool, role: 'hot-spare' });
    removeToSpares(db(), a.id);
    assignDrive(db(), { driveId: b.id, slotId: slots[0]!, role: 'data' });
    expect(memberRows(b.id)[0]).toMatchObject({ poolId: pool, role: 'data' });
  });
});

describe('previous occupant ordering (R35)', () => {
  it('R35: the last occupant is the latest by insertion, whatever the event timestamps say', () => {
    const { slots } = setup();
    const p1 = makePool('one');
    const p2 = makePool('two');
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: p1 });
    removeToSpares(db(), a.id);
    assignDrive(db(), { driveId: b.id, slotId: slots[0]!, poolId: p2 });
    removeToSpares(db(), b.id);
    opened.sqlite.exec(
      `UPDATE events SET at = '2099-01-01T00:00:00.000Z'
        WHERE id IN (SELECT event_id FROM event_drives WHERE drive_id = '${a.id}')`,
    );
    expect(getAssignmentDefaults(db(), slots[0]!)).toMatchObject({
      poolId: p2,
      previousDriveId: b.id,
    });
  });

  it('R35: other slots do not leak into the answer', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    assignDrive(db(), { driveId: b.id, slotId: slots[1]! });
    removeToSpares(db(), b.id);
    expect(getAssignmentDefaults(db(), slots[1]!).previousDriveId).toBe(b.id);
    expect(getAssignmentDefaults(db(), slots[2]!).previousDriveId).toBeNull();
  });
});

describe('remove, retire, RMA, reinstate (R60, R61, R27)', () => {
  it('R14, R74: installed -> spare clears the slot, ends the membership, logs pool-left and ONE drive-removed (slot from)', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool });
    const out = removeToSpares(db(), a.id, { note: 'shelf' });
    expect(out).toMatchObject({ status: 'spare', slotId: null });
    expect(memberRows(a.id)[0]!.endedAt).not.toBeNull();
    expect(types(a.id).slice(0, 2)).toEqual(['drive-removed', 'pool-left']);
    const removed = eventOf(a.id, 'drive-removed');
    expect(driveLinks(removed)).toEqual(subject(a.id));
    expect(slotLinks(removed)).toEqual([{ slotId: slots[0], role: 'from' }]);
    expect(poolLinks(eventOf(a.id, 'pool-left'))).toEqual([pool]);
    expect(removed.payload).toEqual({
      poolId: pool,
      role: 'data',
      installedOn: TODAY(),
      removedOn: TODAY(), // R69: omitted removal date = today
      note: 'shelf',
    });
  });

  it('remove on a spare or retired drive is a conflict', () => {
    setup();
    const a = spare('A');
    expect(thrown(() => removeToSpares(db(), a.id)).code).toBe('conflict');
    retireDrive(db(), a.id, { reason: 'other' });
    expect(thrown(() => removeToSpares(db(), a.id)).code).toBe('conflict');
  });

  it('R60: spare -> retired with default date today, reason and note', () => {
    setup();
    const a = spare('A');
    const r = retireDrive(db(), a.id, { reason: 'replaced', note: 'n' });
    expect(r).toMatchObject({
      status: 'retired',
      slotId: null,
      retirementReason: 'replaced',
      retirementDate: TODAY(),
      retirementNote: 'n',
    });
    const retired = eventOf(a.id, 'drive-retired');
    expect(retired.payload).toMatchObject({ reason: 'replaced', date: TODAY(), note: 'n' });
    expect(driveLinks(retired)).toEqual(subject(a.id));
    expect(retired.links.slots).toEqual([]); // a spare has no bay to leave
  });

  it('R60, R74: installed -> retired frees the slot and ends the membership with ONE drive-retired event (slot from)', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool });
    const r = retireDrive(db(), a.id, { reason: 'failed', date: '2026-03-04' });
    expect(r).toMatchObject({ status: 'retired', slotId: null });
    expect(types(a.id)).toEqual([
      'drive-retired',
      'pool-left',
      'drive-installed',
      'pool-joined',
      'drive-created',
    ]);
    expect(slotLinks(eventOf(a.id, 'drive-retired'))).toEqual([{ slotId: slots[0], role: 'from' }]);
    expect(eventOf(a.id, 'drive-retired').payload).toMatchObject({
      reason: 'failed',
      date: '2026-03-04',
    });
    expect(memberRows(a.id)[0]!.endedAt).not.toBeNull();
    // the freed slot can take another drive
    const b = spare('B');
    expect(assignDrive(db(), { driveId: b.id, slotId: slots[0]! }).drive.slotId).toBe(slots[0]);
  });

  it('R60: an already retired drive cannot be retired again', () => {
    setup();
    const a = spare('A');
    retireDrive(db(), a.id, { reason: 'other' });
    expect(thrown(() => retireDrive(db(), a.id, { reason: 'other' })).code).toBe('conflict');
  });

  it('R27, R74: RMA from installed is ONE drive-sent-for-rma event (slot from) that retires the drive as failed', () => {
    const { slots } = setup();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const r = sendForRma(db(), a.id, { note: 'ticket 1' });
    expect(r).toMatchObject({
      status: 'retired',
      retirementReason: 'failed',
      retirementDate: TODAY(),
    });
    expect(types(a.id)).toEqual(['drive-sent-for-rma', 'drive-installed', 'drive-created']);
    const rma = eventOf(a.id, 'drive-sent-for-rma');
    expect(rma.payload).toMatchObject({ date: TODAY(), note: 'ticket 1' });
    expect(driveLinks(rma)).toEqual(subject(a.id));
    expect(slotLinks(rma)).toEqual([{ slotId: slots[0], role: 'from' }]);
  });

  it('R27: RMA from a spare works; from retired is a conflict', () => {
    setup();
    const a = spare('A');
    sendForRma(db(), a.id);
    expect(getDrive(db(), a.id).status).toBe('retired');
    expect(thrown(() => sendForRma(db(), a.id)).code).toBe('conflict');
  });

  it('R61: retired -> spare clears retirement fields and keeps them in the event', () => {
    const slot = setup().slots[0]!;
    const a = spare('A');
    retireDrive(db(), a.id, {
      reason: 'replaced',
      date: '2026-01-02',
      note: 'x',
    });
    const r = reinstateDrive(db(), a.id, { note: 'false alarm' });
    expect(r).toMatchObject({
      status: 'spare',
      slotId: null,
      retirementReason: null,
      retirementDate: null,
      retirementNote: null,
    });
    expect(eventOf(a.id, 'drive-reinstated').payload).toEqual({
      previousReason: 'replaced',
      previousDate: '2026-01-02',
      previousNote: 'x',
      note: 'false alarm',
    });
    expect(types(a.id)).toContain('drive-retired');
    expect(driveLinks(eventOf(a.id, 'drive-reinstated'))).toEqual(subject(a.id));
    // reinstated drives can be assigned again
    expect(assignDrive(db(), { driveId: a.id, slotId: slot }).drive.status).toBe('installed');
  });

  it('R61: reinstating a non-retired drive is a conflict', () => {
    setup();
    const a = spare('A');
    expect(thrown(() => reinstateDrive(db(), a.id)).code).toBe('conflict');
  });
});

describe('invariants and atomicity (D7, R14)', () => {
  it('D7: the database rejects two drives in one slot and a slot on a non-installed drive', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    expect(() =>
      opened.sqlite
        .prepare(
          "UPDATE drives SET status='installed', installed_on='2026-01-01', slot_id=? WHERE id=?",
        )
        .run(slots[0], b.id),
    ).toThrow(/UNIQUE/);
    expect(() =>
      opened.sqlite.prepare('UPDATE drives SET slot_id=? WHERE id=?').run(slots[1], b.id),
    ).toThrow(/CHECK/);
  });

  it('a failing event write mid-transaction leaves no partial state (assign with occupant)', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool });
    const before = db().select().from(events).all().length;
    const links = () => ({
      drives: db().select().from(eventDrives).all().length,
      slots: db().select().from(eventSlots).all().length,
      pools: db().select().from(eventPools).all().length,
    });
    const linksBefore = links();
    // Fails on the final drive-replaced event, after occupant and incoming rows were changed.
    opened.sqlite.exec(
      "CREATE TRIGGER fail_replaced BEFORE INSERT ON events WHEN NEW.type = 'drive-replaced' BEGIN SELECT RAISE(ABORT, 'event write failed'); END;",
    );
    expect(() =>
      assignDrive(db(), {
        driveId: b.id,
        slotId: slots[0]!,
        occupant: { action: 'retire', reason: 'replaced', date: '2026-01-02' },
      }),
    ).toThrow(/event write failed/);
    expect(getDrive(db(), a.id)).toMatchObject({ status: 'installed', slotId: slots[0] });
    expect(getDrive(db(), b.id)).toMatchObject({ status: 'spare', slotId: null });
    expect(memberRows(a.id)[0]!.endedAt).toBeNull();
    expect(memberRows(b.id)).toHaveLength(0);
    expect(db().select().from(events).all().length).toBe(before);
    expect(links()).toEqual(linksBefore);
  });

  it('R14, R74: a failing LINK write rolls back the event, the change and the other links', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool });
    const eventsBefore = db().select().from(events).all().length;
    const driveLinksBefore = db().select().from(eventDrives).all().length;
    opened.sqlite.exec(
      "CREATE TRIGGER fail_slot_link BEFORE INSERT ON event_slots BEGIN SELECT RAISE(ABORT, 'link write failed'); END;",
    );
    expect(() =>
      assignDrive(db(), { driveId: b.id, slotId: slots[0]!, occupant: { action: 'spare' } }),
    ).toThrow(/link write failed/);
    expect(getDrive(db(), a.id)).toMatchObject({ status: 'installed', slotId: slots[0] });
    expect(getDrive(db(), b.id)).toMatchObject({ status: 'spare', slotId: null });
    expect(db().select().from(events).all()).toHaveLength(eventsBefore);
    expect(db().select().from(eventDrives).all()).toHaveLength(driveLinksBefore);
    expect(memberRows(a.id)[0]!.endedAt).toBeNull();
  });

  it('a failing retire event rolls back the removal too', () => {
    const { slots } = setup();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    opened.sqlite.exec(
      "CREATE TRIGGER fail_retired BEFORE INSERT ON events WHEN NEW.type = 'drive-retired' BEGIN SELECT RAISE(ABORT, 'event write failed'); END;",
    );
    expect(() => retireDrive(db(), a.id, { reason: 'failed' })).toThrow(/event write failed/);
    expect(getDrive(db(), a.id)).toMatchObject({ status: 'installed', slotId: slots[0] });
    expect(types(a.id)).toEqual(['drive-installed', 'drive-created']);
    expect(db().select().from(drives).all()).toHaveLength(1);
  });
});

describe('assignment API', () => {
  let app: FastifyInstance;
  beforeEach(async () => {
    app = buildApp({ db: db() });
    await app.ready();
  });
  afterEach(async () => {
    await app.close();
  });

  it('R8: POST remove with a JSON content type and no body works (empty body is {})', async () => {
    const { slots } = setup();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const res = await app.inject({
      method: 'POST',
      url: `/api/drives/${a.id}/remove`,
      headers: { 'content-type': 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: a.id, status: 'spare' });
  });

  it('assign happy path returns { drive, occupant }, and 409 for an occupied slot', async () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    const ok = await app.inject({
      method: 'POST',
      url: `/api/slots/${slots[0]}/assign`,
      payload: { driveId: a.id },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ drive: { id: a.id, status: 'installed', slotId: slots[0] } });

    const busy = await app.inject({
      method: 'POST',
      url: `/api/slots/${slots[0]}/assign`,
      payload: { driveId: b.id },
    });
    expect(busy.statusCode).toBe(409);
    expect(busy.json()).toMatchObject({
      error: { code: 'conflict', details: { occupant: { driveId: a.id, serial: 'A' } } },
    });

    const swap = await app.inject({
      method: 'POST',
      url: `/api/slots/${slots[0]}/assign`,
      payload: {
        driveId: b.id,
        occupant: { action: 'retire', reason: 'replaced', date: '2026-01-02' },
      },
    });
    expect(swap.statusCode).toBe(200);
    expect(swap.json()).toMatchObject({
      drive: { id: b.id },
      occupant: { id: a.id, status: 'retired' },
    });
  });

  it('defaults, remove, retire, rma and reinstate routes', async () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    const c = spare('C');
    await app.inject({
      method: 'POST',
      url: `/api/slots/${slots[0]}/assign`,
      payload: { driveId: a.id, poolId: pool, role: 'hot-spare' },
    });
    const defaults = await app.inject({
      method: 'GET',
      url: `/api/slots/${slots[0]}/assignment-defaults`,
    });
    expect(defaults.json()).toEqual({ poolId: pool, role: 'hot-spare', previousDriveId: a.id });

    const removed = await app.inject({ method: 'POST', url: `/api/drives/${a.id}/remove` });
    expect(removed.json()).toMatchObject({ status: 'spare', slotId: null });

    const retired = await app.inject({
      method: 'POST',
      url: `/api/drives/${a.id}/retire`,
      payload: { reason: 'other', date: '2026-01-02' },
    });
    expect(retired.json()).toMatchObject({ status: 'retired', retirementReason: 'other' });
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/drives/${a.id}/retire`,
          payload: { reason: 'other' },
        })
      ).statusCode,
    ).toBe(409);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: `/api/drives/${a.id}/retire`,
          payload: { reason: 'bad' },
        })
      ).statusCode,
    ).toBe(400);

    const re = await app.inject({ method: 'POST', url: `/api/drives/${a.id}/reinstate` });
    expect(re.json()).toMatchObject({ status: 'spare', retirementReason: null });

    const rma = await app.inject({ method: 'POST', url: `/api/drives/${c.id}/rma`, payload: {} });
    expect(rma.json()).toMatchObject({ status: 'retired', retirementReason: 'failed' });

    const missing = await app.inject({ method: 'POST', url: '/api/drives/nope/remove' });
    expect(missing.statusCode).toBe(404);
  });
});
