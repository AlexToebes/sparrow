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
import { drives, events, memberships, pools } from '../src/db/schema.js';

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
  it('spare -> installed: sets slot, logs drive-installed with labels at the time', () => {
    const { slots } = setup();
    const d = spare('A');
    const { drive, occupant } = assignDrive(db(), { driveId: d.id, slotId: slots[0]! });
    expect(occupant).toBeUndefined();
    expect(drive).toMatchObject({ status: 'installed', slotId: slots[0] });
    expect(getDrive(db(), d.id)).toEqual(drive);
    expect(types(d.id)).toEqual(['drive-installed', 'drive-created']);
    expect(eventOf(d.id, 'drive-installed').payload).toEqual({
      slotId: slots[0],
      slotLabel: 'Slot 1',
      gridId: expect.any(String),
      gridName: 'Front',
      poolId: null,
      role: null,
      installedOn: TODAY(),
    });
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
    expect(eventOf(d.id, 'pool-joined').payload).toMatchObject({ poolId: pool, role: 'data' });
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

  it('occupant -> spare: removed event, then incoming installed', () => {
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
    expect(types(a.id)).toEqual(['drive-removed', 'drive-installed', 'drive-created']);
  });

  it("R62: occupant 'retire' as replaced defaults replacedBy to the incoming drive", () => {
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
      replacedByDriveId: b.id,
      retirementNote: 'old',
    });
    expect(types(a.id)).toEqual([
      'drive-retired',
      'drive-removed',
      'drive-installed',
      'drive-created',
    ]);
    expect(getDrive(db(), b.id).status).toBe('installed');
  });

  it('retire with reason failed leaves replacedBy empty unless given', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const res = assignDrive(db(), {
      driveId: b.id,
      slotId: slots[0]!,
      occupant: { action: 'retire', reason: 'failed', date: '2026-01-02' },
    });
    expect(res.occupant!.replacedByDriveId).toBeNull();
  });

  it('occupant rma: retired as failed plus drive-sent-for-rma', () => {
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
    expect(types(a.id).slice(0, 4)).toEqual([
      'drive-sent-for-rma',
      'drive-retired',
      'drive-removed',
      'drive-installed',
    ]);
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
    expect(eventOf(b.id, 'drive-installed').payload).toMatchObject({
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
      `UPDATE events SET at = '2099-01-01T00:00:00.000Z' WHERE drive_id = '${a.id}'`,
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

describe('replacement chains and explicit null (R60, R62)', () => {
  it('R60: rejects a replacement chain that loops back to the retired drive', () => {
    const a = spare('A');
    const b = spare('B');
    const c = spare('C');
    retireDrive(db(), a.id, { reason: 'replaced', replacedByDriveId: b.id });
    expect(
      thrown(() => retireDrive(db(), b.id, { reason: 'replaced', replacedByDriveId: a.id })).code,
    ).toBe('invalid');
    retireDrive(db(), c.id, { reason: 'replaced', replacedByDriveId: a.id }); // a -> b, c -> a: fine
    expect(getDrive(db(), b.id).status).toBe('spare');
    expect(
      thrown(() => retireDrive(db(), b.id, { reason: 'replaced', replacedByDriveId: c.id })).code,
    ).toBe('invalid');
  });

  it('R60: the assign-with-retire flow rejects a loop and changes nothing', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    const x = spare('X');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    retireDrive(db(), x.id, { reason: 'replaced', replacedByDriveId: a.id });
    const err = thrown(() =>
      assignDrive(db(), {
        driveId: b.id,
        slotId: slots[0]!,
        occupant: {
          action: 'retire',
          reason: 'replaced',
          date: '2026-01-02',
          replacedByDriveId: x.id,
        },
      }),
    );
    expect(err.code).toBe('invalid');
    expect(getDrive(db(), a.id).status).toBe('installed');
    expect(getDrive(db(), b.id).status).toBe('spare');
  });

  it('R62: an explicit null replacedByDriveId means no replacement; undefined prefills the incoming drive', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const res = assignDrive(db(), {
      driveId: b.id,
      slotId: slots[0]!,
      occupant: {
        action: 'retire',
        reason: 'replaced',
        date: '2026-01-02',
        replacedByDriveId: null,
      },
    });
    expect(res.occupant!.replacedByDriveId).toBeNull();
  });
});

describe('remove, retire, RMA, reinstate (R60, R61, R27)', () => {
  it('installed -> spare: clears slot, ends membership, logs pool-left and drive-removed', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool });
    const out = removeToSpares(db(), a.id, { note: 'shelf' });
    expect(out).toMatchObject({ status: 'spare', slotId: null });
    expect(memberRows(a.id)[0]!.endedAt).not.toBeNull();
    expect(types(a.id).slice(0, 2)).toEqual(['drive-removed', 'pool-left']);
    expect(eventOf(a.id, 'drive-removed').payload).toEqual({
      slotId: slots[0],
      slotLabel: 'Slot 1',
      gridName: 'Front',
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

  it('R60: spare -> retired with default date today, reason, note and replacedBy', () => {
    setup();
    const a = spare('A');
    const b = spare('B');
    const r = retireDrive(db(), a.id, { reason: 'replaced', replacedByDriveId: b.id, note: 'n' });
    expect(r).toMatchObject({
      status: 'retired',
      slotId: null,
      retirementReason: 'replaced',
      retirementDate: TODAY(),
      replacedByDriveId: b.id,
      retirementNote: 'n',
    });
    expect(eventOf(a.id, 'drive-retired').payload).toEqual({
      reason: 'replaced',
      date: TODAY(),
      replacedByDriveId: b.id,
      note: 'n',
      slotId: null,
    });
  });

  it('R60: installed -> retired frees the slot, ends membership, logs removed then retired', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool });
    const r = retireDrive(db(), a.id, { reason: 'failed', date: '2026-03-04' });
    expect(r).toMatchObject({ status: 'retired', slotId: null });
    expect(types(a.id)).toEqual([
      'drive-retired',
      'drive-removed',
      'pool-left',
      'drive-installed',
      'pool-joined',
      'drive-created',
    ]);
    expect(eventOf(a.id, 'drive-retired').payload).toMatchObject({ slotId: slots[0] });
    expect(memberRows(a.id)[0]!.endedAt).not.toBeNull();
    // the freed slot can take another drive
    const b = spare('B');
    expect(assignDrive(db(), { driveId: b.id, slotId: slots[0]! }).drive.slotId).toBe(slots[0]);
  });

  it('R60: already retired, self-replacement and unknown replacement are rejected', () => {
    setup();
    const a = spare('A');
    expect(
      thrown(() => retireDrive(db(), a.id, { reason: 'other', replacedByDriveId: a.id })).code,
    ).toBe('invalid');
    expect(
      thrown(() => retireDrive(db(), a.id, { reason: 'other', replacedByDriveId: 'zz' })).code,
    ).toBe('not-found');
    expect(getDrive(db(), a.id).status).toBe('spare');
    retireDrive(db(), a.id, { reason: 'other' });
    expect(thrown(() => retireDrive(db(), a.id, { reason: 'other' })).code).toBe('conflict');
  });

  it('R27: RMA from installed = removed, retired as failed, drive-sent-for-rma', () => {
    const { slots } = setup();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const r = sendForRma(db(), a.id, { note: 'ticket 1' });
    expect(r).toMatchObject({
      status: 'retired',
      retirementReason: 'failed',
      retirementDate: TODAY(),
    });
    expect(types(a.id).slice(0, 3)).toEqual([
      'drive-sent-for-rma',
      'drive-retired',
      'drive-removed',
    ]);
    expect(eventOf(a.id, 'drive-sent-for-rma').payload).toMatchObject({
      date: TODAY(),
      note: 'ticket 1',
      slotId: slots[0],
    });
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
    const b = spare('B');
    retireDrive(db(), a.id, {
      reason: 'replaced',
      date: '2026-01-02',
      replacedByDriveId: b.id,
      note: 'x',
    });
    const r = reinstateDrive(db(), a.id, { note: 'false alarm' });
    expect(r).toMatchObject({
      status: 'spare',
      slotId: null,
      retirementReason: null,
      retirementDate: null,
      replacedByDriveId: null,
      retirementNote: null,
    });
    expect(eventOf(a.id, 'drive-reinstated').payload).toEqual({
      previousReason: 'replaced',
      previousDate: '2026-01-02',
      previousReplacedByDriveId: b.id,
      previousNote: 'x',
      note: 'false alarm',
    });
    expect(types(a.id)).toContain('drive-retired');
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
    // Fails on the final drive-installed event, after occupant and incoming rows were changed.
    opened.sqlite.exec(
      "CREATE TRIGGER fail_installed BEFORE INSERT ON events WHEN NEW.type = 'drive-installed' BEGIN SELECT RAISE(ABORT, 'event write failed'); END;",
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
      occupant: { id: a.id, status: 'retired', replacedByDriveId: b.id },
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
