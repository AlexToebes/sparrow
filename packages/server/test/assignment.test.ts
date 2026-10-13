import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
import { createLayoutService } from '../src/core/layout.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { activities, drives, events, installations, pools } from '../src/db/schema.js';
import {
  activitiesOf,
  byDrive,
  countActivities,
  eventsOfDrive,
  lastActivity,
  ofType,
  shape,
} from './activity-helpers.js';

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
const types = (id: string) => eventsOfDrive(db(), id).map((e) => e.type);
const installationOf = (driveId: string) =>
  db()
    .select()
    .from(installations)
    .all()
    .find((i) => i.driveId === driveId);

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
  it('R14: spare -> installed in an empty slot is ONE `assigned` activity with one drive-installed event', () => {
    const { slots } = setup();
    const d = spare('A');
    const before = countActivities(db());
    const { drive, occupant } = assignDrive(db(), { driveId: d.id, slotId: slots[0]! });
    expect(occupant).toBeUndefined();
    expect(drive).toMatchObject({ status: 'installed', slotId: slots[0], installedOn: TODAY() });
    expect(getDrive(db(), d.id)).toEqual(drive);
    expect(countActivities(db())).toBe(before + 1);
    const a = lastActivity(db());
    // The activity's date IS the installation date (R68); the event repeats neither it nor the row.
    expect(a).toMatchObject({ kind: 'assigned', occurredOn: TODAY(), note: null });
    expect(shape(a)).toEqual(['drive-installed']);
    const installed = a.events[0]!;
    expect(installed.payload).toEqual({ poolRole: null });
    expect(installed).toMatchObject({ driveId: d.id, slotId: slots[0], poolId: null });
    // The bay's label and grid are copied into the event, so they survive renames and deletion (R39).
    expect(installed).toMatchObject({ slotLabel: 'Slot 1', gridName: 'Front' });
    expect(installed.poolName).toBeNull();
  });

  it('R35: an explicit pool is a property of the installation; role defaults to data; no pool event', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slots[0]!, poolId: pool });
    expect(installationOf(d.id)).toMatchObject({
      slotId: slots[0],
      poolId: pool,
      poolRole: 'data',
    });
    expect(getDrive(db(), d.id)).toMatchObject({ poolId: pool, poolRole: 'data' });
    // Installing sets the pool as part of drive-installed; pool-joined is only for an existing installation.
    expect(types(d.id)).toEqual(['drive-installed', 'drive-created']);
    const installed = ofType(lastActivity(db()), 'drive-installed')[0]!;
    expect(installed).toMatchObject({ poolId: pool, poolName: 'tank' });
    expect(installed.payload).toEqual({ poolRole: 'data' });
  });

  it('R8: a retired drive cannot be assigned', () => {
    const { slots } = setup();
    const d = spare('A');
    retireDrive(db(), d.id, { reason: 'failed' });
    const before = countActivities(db());
    const err = thrown(() => assignDrive(db(), { driveId: d.id, slotId: slots[0]! }));
    expect(err.code).toBe('invalid');
    expect(err.message).toBe('Retired drives cannot be assigned');
    expect(countActivities(db())).toBe(before);
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

  it('R68: the activity date is the installation date; null is "not recorded"', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2025-03-04' });
    expect(lastActivity(db()).occurredOn).toBe('2025-03-04');
    expect(getDrive(db(), a.id).installedOn).toBe('2025-03-04');
    assignDrive(db(), { driveId: b.id, slotId: slots[1]!, installedOn: null });
    expect(lastActivity(db()).occurredOn).toBeNull();
    expect(getDrive(db(), b.id).installedOn).toBeNull();
  });
});

describe('occupied slot (R37, R62)', () => {
  it('R37: rejects with 409 details naming the occupant and changes nothing', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const before = countActivities(db());
    const err = thrown(() => assignDrive(db(), { driveId: b.id, slotId: slots[0]! }));
    expect(err.code).toBe('conflict');
    expect(err.details).toEqual({ occupant: { driveId: a.id, serial: 'A' } });
    expect(getDrive(db(), a.id).status).toBe('installed');
    expect(getDrive(db(), b.id).status).toBe('spare');
    expect(countActivities(db())).toBe(before);
  });

  it('R14: occupant -> spare is ONE `replaced` activity: the outgoing is uninstalled, the incoming installed', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2025-01-01' });
    const res = assignDrive(db(), {
      driveId: b.id,
      slotId: slots[0]!,
      occupant: { action: 'spare' },
    });
    expect(res.occupant).toMatchObject({ id: a.id, status: 'spare', slotId: null });
    expect(res.drive).toMatchObject({ id: b.id, status: 'installed', slotId: slots[0] });
    const act = lastActivity(db());
    expect(act).toMatchObject({ kind: 'replaced', occurredOn: TODAY() });
    expect(byDrive(act)).toEqual([
      [a.id, 'drive-uninstalled'],
      [b.id, 'drive-installed'],
    ]);
    // Both events are in the one activity, so each drive's history sees the whole replacement.
    expect(types(a.id)).toEqual(['drive-uninstalled', 'drive-installed', 'drive-created']);
    expect(types(b.id)).toEqual(['drive-installed', 'drive-created']);
    // The uninstall carries what it deleted (the OLD installed-on, pool role); the removal day is the activity's.
    expect(act.events[0]!.payload).toEqual({ installedOn: '2025-01-01', poolRole: null });
    expect(act.events[0]).toMatchObject({ slotId: slots[0], slotLabel: 'Slot 1' });
    expect(act.events[1]).toMatchObject({ slotId: slots[0] });
  });

  it("R62: occupant 'retire' keeps the user's reason and note; the date is the activity date", () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2025-12-01' });
    const res = assignDrive(db(), {
      driveId: b.id,
      slotId: slots[0]!,
      installedOn: '2026-01-02',
      occupant: { action: 'retire', reason: 'replaced', date: '2026-01-02', note: 'old' },
    });
    expect(res.occupant).toMatchObject({
      status: 'retired',
      slotId: null,
      retirementReason: 'replaced',
      retirementDate: '2026-01-02',
      retirementNote: 'old',
    });
    const act = lastActivity(db());
    expect(act.occurredOn).toBe('2026-01-02');
    expect(byDrive(act)).toEqual([
      [a.id, 'drive-uninstalled'],
      [a.id, 'drive-retired'],
      [b.id, 'drive-installed'],
    ]);
    // The retirement date is the activity's, so the event carries only the reason and the note.
    expect(act.events[1]!.payload).toEqual({ reason: 'replaced', note: 'old' });
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

  it('R27: occupant rma is a drive-sent-for-rma event next to the uninstall', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2026-01-01' });
    const res = assignDrive(db(), {
      driveId: b.id,
      slotId: slots[0]!,
      installedOn: '2026-02-03',
      occupant: { action: 'rma' },
    });
    expect(res.occupant).toMatchObject({
      status: 'retired',
      retirementReason: 'failed',
      retirementDate: '2026-02-03',
    });
    const act = lastActivity(db());
    expect(shape(act)).toEqual(['drive-uninstalled', 'drive-sent-for-rma', 'drive-installed']);
    expect(act.events[1]!.payload).toEqual({ note: null });
  });

  it('R69, R73: a replacement is one act, so the occupant leaves on the installation day', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2025-01-01' });
    // Backdated install: with no occupant date given, the occupant leaves that same day, not today.
    const res = assignDrive(db(), {
      driveId: b.id,
      slotId: slots[0]!,
      installedOn: '2025-06-01',
      occupant: { action: 'retire', reason: 'failed' },
    });
    expect(res.occupant).toMatchObject({ retirementDate: '2025-06-01' });
    expect(lastActivity(db()).occurredOn).toBe('2025-06-01');
  });

  it('R69, R73: a differing occupant date is a 400 and changes nothing', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const before = countActivities(db());
    for (const occupant of [
      { action: 'spare', removedOn: '2025-01-01' },
      { action: 'spare', removedOn: null },
      { action: 'retire', reason: 'failed', date: '2025-01-01' },
      { action: 'rma', date: null },
    ] as const) {
      const err = thrown(() =>
        assignDrive(db(), { driveId: b.id, slotId: slots[0]!, installedOn: TODAY(), occupant }),
      );
      expect(err.code).toBe('invalid');
      expect(err.message).toMatch(/same day as the replacement/);
    }
    // The same day, explicitly, is fine.
    assignDrive(db(), {
      driveId: b.id,
      slotId: slots[0]!,
      installedOn: TODAY(),
      occupant: { action: 'spare', removedOn: TODAY() },
    });
    expect(countActivities(db())).toBe(before + 1);
    expect(getDrive(db(), a.id).status).toBe('spare');
  });

  it('R69: with the installation date not recorded the occupant removal is not recorded either', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    assignDrive(db(), {
      driveId: b.id,
      slotId: slots[0]!,
      installedOn: null,
      occupant: { action: 'spare' },
    });
    const act = lastActivity(db());
    expect(act.occurredOn).toBeNull();
    expect(getDrive(db(), b.id).installedOn).toBeNull();
  });

  it("R69: the occupant can't leave before it went in (checked against its own installed-on)", () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2026-03-01' });
    const before = countActivities(db());
    const err = thrown(() =>
      assignDrive(db(), {
        driveId: b.id,
        slotId: slots[0]!,
        installedOn: '2026-02-01',
        occupant: { action: 'spare' },
      }),
    );
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/can't be removed before it was installed/);
    expect(countActivities(db())).toBe(before);
    expect(getDrive(db(), a.id).status).toBe('installed');
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
      occupant: { action: 'retire', reason: 'replaced' },
    });
    // The outgoing drive leaves the pool with its installation: no pool-left event, the uninstall names the pool.
    expect(installationOf(a.id)).toBeUndefined();
    const act = lastActivity(db());
    expect(shape(act)).not.toContain('pool-left');
    expect(act.events[0]).toMatchObject({ type: 'drive-uninstalled', poolId: pool });
    expect(act.events[0]!.payload).toMatchObject({ poolRole: 'hot-spare' });
    expect(installationOf(b.id)).toMatchObject({ poolId: pool, poolRole: 'hot-spare' });
    expect(ofType(act, 'drive-installed')[0]).toMatchObject({ poolId: pool, poolName: 'tank' });
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
    expect(installationOf(b.id)).toMatchObject({ poolId: pool, poolRole: 'hot-spare' });
  });

  it('explicit null pool means no pool even when the previous occupant had one', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool });
    removeToSpares(db(), a.id);
    assignDrive(db(), { driveId: b.id, slotId: slots[0]!, poolId: null, role: 'hot-spare' });
    expect(installationOf(b.id)).toMatchObject({ poolId: null, poolRole: null });
    expect(ofType(lastActivity(db()), 'drive-installed')[0]).toMatchObject({ poolId: null });
  });

  it('explicit role overrides the previous role', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool, role: 'hot-spare' });
    removeToSpares(db(), a.id);
    assignDrive(db(), { driveId: b.id, slotId: slots[0]!, role: 'data' });
    expect(installationOf(b.id)).toMatchObject({ poolId: pool, poolRole: 'data' });
  });
});

describe('previous occupant ordering (R35)', () => {
  it('R35: the last occupant is the latest by log position (seq), whatever the timestamps say', () => {
    const { slots } = setup();
    const p1 = makePool('one');
    const p2 = makePool('two');
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: p1 });
    removeToSpares(db(), a.id);
    assignDrive(db(), { driveId: b.id, slotId: slots[0]!, poolId: p2 });
    removeToSpares(db(), b.id);
    opened.sqlite.exec(`UPDATE activities SET recorded_at = '2099-01-01T00:00:00.000Z' WHERE seq = (
      SELECT a.seq FROM activities a JOIN events e ON e.activity_id = a.id
       WHERE e.drive_id = '${a.id}' AND e.type = 'drive-uninstalled')`);
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
  it('R14: installed -> spare is a `removed` activity with ONE drive-uninstalled event; the note is the activity note', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool });
    const out = removeToSpares(db(), a.id, { note: 'shelf' });
    expect(out).toMatchObject({ status: 'spare', slotId: null, poolId: null });
    expect(installationOf(a.id)).toBeUndefined();
    const act = lastActivity(db());
    expect(act).toMatchObject({ kind: 'removed', note: 'shelf', occurredOn: TODAY() }); // R69: omitted = today
    expect(shape(act)).toEqual(['drive-uninstalled']);
    expect(act.events[0]).toMatchObject({ driveId: a.id, slotId: slots[0], poolId: pool });
    expect(act.events[0]!.payload).toEqual({ installedOn: TODAY(), poolRole: 'data' });
  });

  it('R69: the removal date is the activity date; null is not recorded', () => {
    const { slots } = setup();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2025-01-01' });
    removeToSpares(db(), a.id, { removedOn: '2025-02-02' });
    expect(lastActivity(db()).occurredOn).toBe('2025-02-02');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, installedOn: '2025-03-01' });
    removeToSpares(db(), a.id, { removedOn: null });
    expect(lastActivity(db()).occurredOn).toBeNull();
  });

  it('remove on a spare or retired drive is a conflict', () => {
    setup();
    const a = spare('A');
    expect(thrown(() => removeToSpares(db(), a.id)).code).toBe('conflict');
    retireDrive(db(), a.id, { reason: 'other' });
    expect(thrown(() => removeToSpares(db(), a.id)).code).toBe('conflict');
  });

  it('R60: spare -> retired is a `retired` activity dated today by default, with the reason and note', () => {
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
    const act = lastActivity(db());
    expect(act).toMatchObject({ kind: 'retired', occurredOn: TODAY() });
    expect(shape(act)).toEqual(['drive-retired']); // a spare has no bay to leave
    expect(act.events[0]!.payload).toEqual({ reason: 'replaced', note: 'n' });
  });

  it('R60: installed -> retired is ONE `retired` activity: uninstalled, then drive-retired; the pool leaves with the installation', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    assignDrive(db(), {
      driveId: a.id,
      slotId: slots[0]!,
      poolId: pool,
      installedOn: '2026-01-01',
    });
    const r = retireDrive(db(), a.id, { reason: 'failed', date: '2026-03-04' });
    expect(r).toMatchObject({ status: 'retired', slotId: null, retirementDate: '2026-03-04' });
    const act = lastActivity(db());
    expect(act).toMatchObject({ kind: 'retired', occurredOn: '2026-03-04' });
    expect(shape(act)).toEqual(['drive-uninstalled', 'drive-retired']);
    expect(act.events[0]).toMatchObject({ slotId: slots[0], poolId: pool });
    expect(act.events[1]!.payload).toEqual({ reason: 'failed', note: null });
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

  it('R27: RMA from installed is a `sent-for-rma` activity: uninstalled + ONE drive-sent-for-rma that retires the drive as failed', () => {
    const { slots } = setup();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    const r = sendForRma(db(), a.id, { note: 'ticket 1' });
    expect(r).toMatchObject({
      status: 'retired',
      retirementReason: 'failed',
      retirementDate: TODAY(),
    });
    const act = lastActivity(db());
    expect(act).toMatchObject({ kind: 'sent-for-rma', occurredOn: TODAY() });
    expect(shape(act)).toEqual(['drive-uninstalled', 'drive-sent-for-rma']);
    expect(act.events[1]!.payload).toEqual({ note: 'ticket 1' });
  });

  it('R27: RMA from a spare works; from retired is a conflict', () => {
    setup();
    const a = spare('A');
    sendForRma(db(), a.id);
    expect(getDrive(db(), a.id).status).toBe('retired');
    expect(thrown(() => sendForRma(db(), a.id)).code).toBe('conflict');
  });

  it('R61: retired -> spare clears the retirement fields; the reinstated event holds what it cleared', () => {
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
    const act = lastActivity(db());
    expect(act).toMatchObject({ kind: 'reinstated', note: 'false alarm', occurredOn: null });
    expect(act.events[0]!.payload).toEqual({
      previousReason: 'replaced',
      previousDate: '2026-01-02',
      previousNote: 'x',
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
  it('D7: the database rejects a second drive in a bay and a second bay for a drive', () => {
    const { slots } = setup();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    expect(() =>
      opened.sqlite
        .prepare('INSERT INTO installations (drive_id, slot_id) VALUES (?, ?)')
        .run(b.id, slots[0]),
    ).toThrow(/UNIQUE/);
    expect(() =>
      opened.sqlite
        .prepare('INSERT INTO installations (drive_id, slot_id) VALUES (?, ?)')
        .run(a.id, slots[1]),
    ).toThrow(/UNIQUE|PRIMARY KEY/);
  });

  it('a failing event write mid-transaction leaves no partial state (assign with occupant)', () => {
    const { slots } = setup();
    const pool = makePool('tank');
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]!, poolId: pool });
    const before = db().select().from(events).all().length;
    const activitiesBefore = db().select().from(activities).all().length;
    // Fails on the final drive-installed event, after the occupant and incoming rows were changed.
    opened.sqlite.exec(
      "CREATE TRIGGER fail_installed BEFORE INSERT ON events WHEN NEW.type = 'drive-installed' BEGIN SELECT RAISE(ABORT, 'event write failed'); END;",
    );
    expect(() =>
      assignDrive(db(), {
        driveId: b.id,
        slotId: slots[0]!,
        occupant: { action: 'retire', reason: 'replaced' },
      }),
    ).toThrow(/event write failed/);
    expect(getDrive(db(), a.id)).toMatchObject({ status: 'installed', slotId: slots[0] });
    expect(getDrive(db(), b.id)).toMatchObject({ status: 'spare', slotId: null });
    expect(installationOf(a.id)).toMatchObject({ poolId: pool });
    expect(installationOf(b.id)).toBeUndefined();
    expect(db().select().from(events).all().length).toBe(before);
    expect(db().select().from(activities).all().length).toBe(activitiesBefore);
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

  it('every activity gets the next seq and its events are numbered from 0', () => {
    const { slots } = setup();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slots[0]! });
    removeToSpares(db(), a.id);
    const acts = activitiesOf(db());
    expect(acts.map((x) => x.seq)).toEqual(acts.map((_, i) => i + 1));
    for (const act of acts)
      expect(act.events.map((e) => e.ord)).toEqual(act.events.map((_, i) => i));
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
        occupant: { action: 'retire', reason: 'replaced' },
      },
    });
    expect(swap.statusCode).toBe(200);
    expect(swap.json()).toMatchObject({
      drive: { id: b.id },
      occupant: { id: a.id, status: 'retired' },
    });

    const differing = await app.inject({
      method: 'POST',
      url: `/api/slots/${slots[0]}/assign`,
      payload: {
        driveId: a.id,
        occupant: { action: 'spare', removedOn: '2020-01-01' },
      },
    });
    expect(differing.statusCode).toBe(400);
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

    const removed = await app.inject({
      method: 'POST',
      url: `/api/drives/${a.id}/remove`,
      payload: {},
    });
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

    const re = await app.inject({
      method: 'POST',
      url: `/api/drives/${a.id}/reinstate`,
      payload: {},
    });
    expect(re.json()).toMatchObject({ status: 'spare', retirementReason: null });

    const rma = await app.inject({ method: 'POST', url: `/api/drives/${c.id}/rma`, payload: {} });
    expect(rma.json()).toMatchObject({ status: 'retired', retirementReason: 'failed' });

    const missing = await app.inject({
      method: 'POST',
      url: '/api/drives/nope/remove',
      payload: {},
    });
    expect(missing.statusCode).toBe(404);
  });
});
