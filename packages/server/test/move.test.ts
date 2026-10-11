import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { assignDrive } from '../src/core/assignment.js';
import { createDrive, getDrive } from '../src/core/drives.js';
import { DomainError } from '../src/core/errors.js';
import { listDriveEvents } from '../src/core/events.js';
import { createLayoutService } from '../src/core/layout.js';
import { moveDrive } from '../src/core/move.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { events, memberships, pools } from '../src/db/schema.js';
import { driveLinks, slotLinks, subject } from './event-helpers.js';

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
const TODAY = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function slotIds(): string[] {
  const layout = createLayoutService(db());
  const enclosure = layout.createEnclosure({ name: 'NAS' });
  layout.createGrid(enclosure.id, { name: 'Front', rows: 1, columns: 4, orientation: 'landscape' });
  return layout
    .getLayout()
    .enclosures.flatMap((e) => e.grids.flatMap((g) => g.slots.map((s) => s.id)));
}
function makePool(name: string): string {
  const at = new Date().toISOString();
  db()
    .insert(pools)
    .values({ id: `pool-${name}`, name, layoutLabel: null, createdAt: at, updatedAt: at })
    .run();
  return `pool-${name}`;
}
const spare = (serial: string) => createDrive(db(), { serial });
const log = (driveId: string) => listDriveEvents(db(), driveId);
const ofType = (driveId: string, type: string) => log(driveId).filter((e) => e.type === type);
const members = (driveId: string) =>
  db().select().from(memberships).where(eq(memberships.driveId, driveId)).all();
const eventCount = () => db().select().from(events).all().length;
function thrown(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (e) {
    return e as DomainError;
  }
  throw new Error('expected a throw');
}

/** Drive A in the first bay (pool tank, data), installed 60 days ago; B in the second bay. */
function setup() {
  const [s1, s2, s3, s4] = slotIds() as [string, string, string, string];
  const pool = makePool('tank');
  const a = spare('A');
  const b = spare('B');
  assignDrive(db(), { driveId: a.id, slotId: s1, poolId: pool, installedOn: daysAgo(60) });
  assignDrive(db(), {
    driveId: b.id,
    slotId: s2,
    poolId: pool,
    role: 'hot-spare',
    installedOn: daysAgo(60),
  });
  return { s1, s2, s3, s4, pool, a, b };
}

describe('R73: move to the spares shelf', () => {
  it('R73, R69: goes back to spares with the move date, membership ended', () => {
    const { a, s1 } = setup();
    const result = moveDrive(db(), a.id, { destination: { kind: 'spares' }, date: daysAgo(3) });
    expect(result.drive).toMatchObject({ status: 'spare', slotId: null });
    const removed = ofType(a.id, 'drive-removed')[0]!;
    expect(removed.payload).toMatchObject({ removedOn: daysAgo(3) });
    expect(slotLinks(removed)).toEqual([{ slotId: s1, role: 'from' }]);
    expect(members(a.id)[0]!.endedAt).not.toBeNull();
  });

  it('R73, R35, R60: with a spare taking its place; defaults come from the vacated bay', () => {
    const { a, s1, pool } = setup();
    const c = spare('C');
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'spares' },
      replacement: { driveId: c.id },
      date: daysAgo(2),
    });
    expect(result.replacement).toMatchObject({ id: c.id, status: 'installed', slotId: s1 });
    expect(getDrive(db(), c.id).installedOn).toBe(daysAgo(2));
    expect(members(c.id)[0]).toMatchObject({ poolId: pool, role: 'data', endedAt: null });
    // ONE drive-replaced event for the vacated bay: A outgoing (to the spares), C incoming.
    expect(ofType(c.id, 'drive-installed')).toHaveLength(0);
    expect(ofType(a.id, 'drive-removed')).toHaveLength(0);
    const replaced = ofType(c.id, 'drive-replaced');
    expect(replaced).toHaveLength(1);
    expect(ofType(a.id, 'drive-replaced')[0]!.id).toBe(replaced[0]!.id);
    expect(driveLinks(replaced[0]!)).toEqual([
      { driveId: c.id, role: 'incoming' },
      { driveId: a.id, role: 'outgoing' },
    ]);
    expect(slotLinks(replaced[0]!)).toEqual([{ slotId: s1, role: 'at' }]);
    expect(replaced[0]!.payload).toMatchObject({
      poolId: pool,
      installedOn: daysAgo(2),
      outgoing: { outcome: 'spares', date: daysAgo(2), installedOn: daysAgo(60) },
    });
    expect(ofType(c.id, 'pool-joined')).toHaveLength(1);
  });

  it('R73: omitted date is today; null records no date for any step', () => {
    const { a, b } = setup();
    const c = spare('C');
    const d = spare('D');
    moveDrive(db(), a.id, { destination: { kind: 'spares' }, replacement: { driveId: c.id } });
    expect(getDrive(db(), c.id).installedOn).toBe(TODAY());
    expect(ofType(a.id, 'drive-replaced')[0]!.payload).toMatchObject({
      outgoing: { outcome: 'spares', date: TODAY() },
    });
    moveDrive(db(), b.id, {
      destination: { kind: 'spares' },
      replacement: { driveId: d.id },
      date: null,
    });
    expect(getDrive(db(), d.id).installedOn).toBeNull();
    expect(ofType(b.id, 'drive-replaced')[0]!.payload).toMatchObject({
      installedOn: null,
      outgoing: { outcome: 'spares', date: null },
    });
  });

  it('R73: the replacement can pick another pool, no pool, and a role', () => {
    const { a, b } = setup();
    const other = makePool('scratch');
    const c = spare('C');
    const d = spare('D');
    moveDrive(db(), a.id, {
      destination: { kind: 'spares' },
      replacement: { driveId: c.id, poolId: other, role: 'hot-spare' },
    });
    expect(members(c.id)[0]).toMatchObject({ poolId: other, role: 'hot-spare' });
    moveDrive(db(), b.id, {
      destination: { kind: 'spares' },
      replacement: { driveId: d.id, poolId: null },
    });
    expect(members(d.id)).toHaveLength(0);
  });
});

describe('R73: retire and RMA', () => {
  it('R73, R60: retire without a replacement uses the existing retire semantics', () => {
    const { a, s1 } = setup();
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'retire', reason: 'failed', note: 'clicking' },
      date: daysAgo(4),
    });
    expect(result.drive).toMatchObject({
      status: 'retired',
      retirementReason: 'failed',
      retirementDate: daysAgo(4),
      retirementNote: 'clicking',
    });
    // R14, R74: ONE drive-retired event (slot from); no separate removal.
    expect(ofType(a.id, 'drive-removed')).toHaveLength(0);
    const retired = ofType(a.id, 'drive-retired');
    expect(retired).toHaveLength(1);
    expect(retired[0]!.payload).toMatchObject({
      reason: 'failed',
      date: daysAgo(4),
      note: 'clicking',
    });
    expect(slotLinks(retired[0]!)).toEqual([{ slotId: s1, role: 'from' }]);
    expect(ofType(a.id, 'pool-left')).toHaveLength(1);
  });

  it('R73: retiring with a replacement puts the spare in the vacated bay', () => {
    const { a, s1 } = setup();
    const c = spare('C');
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'retire', reason: 'other' },
      replacement: { driveId: c.id },
    });
    expect(result.drive.status).toBe('retired');
    expect(getDrive(db(), c.id)).toMatchObject({ status: 'installed', slotId: s1 });
    // The departing drive and the spare are ONE drive-replaced event with the retire outcome.
    expect(ofType(a.id, 'drive-retired')).toHaveLength(0);
    expect(ofType(a.id, 'drive-replaced')[0]!.payload).toMatchObject({
      outgoing: { outcome: 'retired', reason: 'other' },
    });
    expect(driveLinks(ofType(a.id, 'drive-replaced')[0]!)).toEqual([
      { driveId: c.id, role: 'incoming' },
      { driveId: a.id, role: 'outgoing' },
    ]);
  });

  it('R73, R27: RMA writes the RMA event; with a replacement the spare takes the bay', () => {
    const { a, b } = setup();
    const c = spare('C');
    moveDrive(db(), a.id, { destination: { kind: 'rma', note: 'sent' }, date: daysAgo(1) });
    expect(getDrive(db(), a.id)).toMatchObject({ status: 'retired', retirementReason: 'failed' });
    const rma = ofType(a.id, 'drive-sent-for-rma');
    expect(rma).toHaveLength(1);
    expect(rma[0]!.payload).toMatchObject({ date: daysAgo(1), note: 'sent' });
    expect(driveLinks(rma[0]!)).toEqual(subject(a.id));
    moveDrive(db(), b.id, { destination: { kind: 'rma' }, replacement: { driveId: c.id } });
    expect(getDrive(db(), b.id).status).toBe('retired');
    expect(getDrive(db(), c.id).status).toBe('installed');
    expect(ofType(b.id, 'drive-replaced')[0]!.payload).toMatchObject({
      outgoing: { outcome: 'rma' },
    });
  });

  it('R73, R60: a retire date of null is not recorded', () => {
    const { a } = setup();
    moveDrive(db(), a.id, { destination: { kind: 'retire', reason: 'failed' }, date: null });
    expect(getDrive(db(), a.id).retirementDate).toBeNull();
    expect(ofType(a.id, 'drive-retired')[0]!.payload).toMatchObject({ date: null });
  });
});

describe('R73: move to another bay', () => {
  it('R73, R29, R74: keeps the open membership; ONE drive-moved event (slots from + to), no pool events', () => {
    const { a, s1, s3, pool } = setup();
    const before = members(a.id);
    const poolEvents = ofType(a.id, 'pool-left').length + ofType(a.id, 'pool-joined').length;
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'slot', slotId: s3 },
      date: daysAgo(5),
    });
    expect(result.drive).toMatchObject({
      status: 'installed',
      slotId: s3,
      installedOn: daysAgo(5),
    });
    expect(members(a.id)).toEqual(before);
    expect(members(a.id)[0]).toMatchObject({ poolId: pool, endedAt: null });
    expect(ofType(a.id, 'pool-left').length + ofType(a.id, 'pool-joined').length).toBe(poolEvents);
    expect(ofType(a.id, 'drive-removed')).toHaveLength(0);
    expect(ofType(a.id, 'drive-installed')).toHaveLength(1); // the original assignment only
    const moved = ofType(a.id, 'drive-moved');
    expect(moved).toHaveLength(1);
    expect(moved[0]!.payload).toMatchObject({
      date: daysAgo(5),
      poolId: pool,
      role: 'data',
      installedOn: daysAgo(60),
    });
    expect(driveLinks(moved[0]!)).toEqual(subject(a.id));
    expect(slotLinks(moved[0]!)).toEqual([
      { slotId: s1, role: 'from' },
      { slotId: s3, role: 'to' },
    ]);
  });

  it('R73, R35: the vacated bay can take a spare in the same step', () => {
    const { a, s1, s3 } = setup();
    const c = spare('C');
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'slot', slotId: s3 },
      replacement: { driveId: c.id },
    });
    expect(result.drive.slotId).toBe(s3);
    expect(result.replacement).toMatchObject({ slotId: s1, status: 'installed' });
    // The default pool and role come from the drive that left, which kept its own membership.
    expect(members(c.id)[0]).toMatchObject({ role: 'data', endedAt: null });
    expect(members(a.id)[0]!.endedAt).toBeNull();
    // The vacated bay's event: A outgoing (moved to s3), C incoming; the target bay is linked `to`.
    // No drive-moved is written because the one replacement event already says where A went.
    expect(ofType(a.id, 'drive-moved')).toHaveLength(0);
    const replaced = ofType(c.id, 'drive-replaced');
    expect(replaced).toHaveLength(1);
    expect(driveLinks(replaced[0]!)).toEqual([
      { driveId: c.id, role: 'incoming' },
      { driveId: a.id, role: 'outgoing' },
    ]);
    expect(slotLinks(replaced[0]!)).toEqual(
      [
        { slotId: s3, role: 'to' },
        { slotId: s1, role: 'at' },
      ].sort((x, y) => x.role.localeCompare(y.role) || x.slotId.localeCompare(y.slotId)),
    );
    expect(replaced[0]!.payload).toMatchObject({
      outgoing: { outcome: 'moved', toSlotId: s3 },
    });
  });

  it('R73: an unrecorded date makes the new installation date null', () => {
    const { a, s3 } = setup();
    moveDrive(db(), a.id, { destination: { kind: 'slot', slotId: s3 }, date: null });
    expect(getDrive(db(), a.id).installedOn).toBeNull();
    expect(ofType(a.id, 'drive-moved')[0]!.payload).toMatchObject({ date: null });
  });

  it('R73, R68: a move date before the installation date is rejected and nothing changes', () => {
    const { a, s1, s3 } = setup();
    const n = eventCount();
    const err = thrown(() =>
      moveDrive(db(), a.id, { destination: { kind: 'slot', slotId: s3 }, date: daysAgo(90) }),
    );
    expect(err.code).toBe('invalid');
    expect(getDrive(db(), a.id).slotId).toBe(s1);
    expect(eventCount()).toBe(n);
  });

  it('R73: the same bay is rejected', () => {
    const { a, s1 } = setup();
    expect(
      thrown(() => moveDrive(db(), a.id, { destination: { kind: 'slot', slotId: s1 } })).code,
    ).toBe('invalid');
  });

  it('R73, R37: an occupied bay without an occupant resolution is a 409 naming the occupant', () => {
    const { a, b, s2, s1 } = setup();
    const err = thrown(() => moveDrive(db(), a.id, { destination: { kind: 'slot', slotId: s2 } }));
    expect(err.code).toBe('conflict');
    expect(err.details).toEqual({ occupant: { driveId: b.id, serial: 'B' } });
    expect(getDrive(db(), a.id).slotId).toBe(s1);
  });

  it('R73, R37: occupant to spares uses the move date', () => {
    const { a, b, s1, s2 } = setup();
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'slot', slotId: s2, occupant: { action: 'spare' } },
      date: daysAgo(2),
    });
    expect(result.drive.slotId).toBe(s2);
    expect(result.occupant).toMatchObject({ id: b.id, status: 'spare' });
    // ONE drive-replaced event for the destination bay: B outgoing (to the spares), A incoming.
    expect(ofType(b.id, 'drive-removed')).toHaveLength(0);
    expect(ofType(a.id, 'drive-removed')).toHaveLength(0);
    const replaced = ofType(b.id, 'drive-replaced');
    expect(replaced).toHaveLength(1);
    expect(replaced[0]!.payload).toMatchObject({
      installedOn: daysAgo(2),
      outgoing: { outcome: 'spares', date: daysAgo(2) },
    });
    expect(driveLinks(replaced[0]!)).toEqual([
      { driveId: a.id, role: 'incoming' },
      { driveId: b.id, role: 'outgoing' },
    ]);
    // No spare fills the vacated bay, so the event also links it as `from`: its history sees A leave.
    expect(slotLinks(replaced[0]!)).toEqual(
      [
        { slotId: s1, role: 'from' },
        { slotId: s2, role: 'at' },
      ].sort((x, y) => x.role.localeCompare(y.role) || x.slotId.localeCompare(y.slotId)),
    );
    expect(members(b.id)[0]!.endedAt).not.toBeNull();
  });

  it('R73, R74: into an occupied bay with a spare filling the vacated bay is TWO drive-replaced events in one transaction', () => {
    const { a, b, s1, s2 } = setup();
    const c = spare('C');
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'slot', slotId: s2, occupant: { action: 'retire', reason: 'failed' } },
      replacement: { driveId: c.id },
      date: daysAgo(2),
    });
    expect(result.drive.slotId).toBe(s2);
    expect(result.occupant).toMatchObject({ id: b.id, status: 'retired' });
    expect(result.replacement).toMatchObject({ id: c.id, slotId: s1 });
    const all = db()
      .select()
      .from(events)
      .all()
      .filter((e) => e.type === 'drive-replaced');
    expect(all).toHaveLength(2);
    const atS2 = ofType(b.id, 'drive-replaced')[0]!;
    const atS1 = ofType(c.id, 'drive-replaced')[0]!;
    expect(atS2.id).not.toBe(atS1.id);
    expect(driveLinks(atS2)).toEqual([
      { driveId: a.id, role: 'incoming' },
      { driveId: b.id, role: 'outgoing' },
    ]);
    expect(slotLinks(atS2)).toEqual([{ slotId: s2, role: 'at' }]);
    expect(atS2.payload).toMatchObject({ outgoing: { outcome: 'retired', reason: 'failed' } });
    expect(driveLinks(atS1)).toEqual([
      { driveId: c.id, role: 'incoming' },
      { driveId: a.id, role: 'outgoing' },
    ]);
    expect(slotLinks(atS1)).toEqual(
      [
        { slotId: s1, role: 'at' },
        { slotId: s2, role: 'to' },
      ].sort((x, y) => x.role.localeCompare(y.role)),
    );
    expect(atS1.payload).toMatchObject({ outgoing: { outcome: 'moved', toSlotId: s2 } });
    // The mover has both, in a sensible order.
    expect(ofType(a.id, 'drive-replaced')).toHaveLength(2);
  });

  it('R73, R37, R62: occupant retired with the chosen reason; dates follow the move', () => {
    const { a, b, s2 } = setup();
    moveDrive(db(), a.id, {
      destination: {
        kind: 'slot',
        slotId: s2,
        occupant: { action: 'retire', reason: 'replaced', note: 'old' },
      },
      date: daysAgo(2),
    });
    expect(getDrive(db(), b.id)).toMatchObject({
      status: 'retired',
      retirementReason: 'replaced',
      retirementDate: daysAgo(2),
      retirementNote: 'old',
    });
  });

  it('R73, R37, R27: occupant to RMA; null date is not recorded', () => {
    const { a, b, s2 } = setup();
    moveDrive(db(), a.id, {
      destination: { kind: 'slot', slotId: s2, occupant: { action: 'rma' } },
      date: null,
    });
    expect(getDrive(db(), b.id).status).toBe('retired');
    expect(ofType(b.id, 'drive-replaced')[0]!.payload).toMatchObject({
      outgoing: { outcome: 'rma', date: null },
    });
  });

  it('R73: an explicit date on the occupant resolution wins over the move date', () => {
    const { a, b, s2 } = setup();
    moveDrive(db(), a.id, {
      destination: {
        kind: 'slot',
        slotId: s2,
        occupant: { action: 'retire', reason: 'failed', date: daysAgo(10) },
      },
      date: daysAgo(1),
    });
    expect(getDrive(db(), b.id).retirementDate).toBe(daysAgo(10));
  });
});

describe('R73: validation and atomicity', () => {
  it('R73: a drive that is not installed is rejected', () => {
    setup();
    const c = spare('C');
    expect(thrown(() => moveDrive(db(), c.id, { destination: { kind: 'spares' } })).code).toBe(
      'conflict',
    );
  });

  it('R73: a missing drive or bay is a 404', () => {
    const { a } = setup();
    expect(thrown(() => moveDrive(db(), 'nope', { destination: { kind: 'spares' } })).code).toBe(
      'not-found',
    );
    expect(
      thrown(() => moveDrive(db(), a.id, { destination: { kind: 'slot', slotId: 'nope' } })).code,
    ).toBe('not-found');
  });

  it('R73, R68: future and malformed dates are rejected before anything changes', () => {
    const { a } = setup();
    const n = eventCount();
    for (const date of [daysAgo(-5), 'yesterday']) {
      expect(
        thrown(() => moveDrive(db(), a.id, { destination: { kind: 'spares' }, date })).code,
      ).toBe('invalid');
    }
    expect(getDrive(db(), a.id).status).toBe('installed');
    expect(eventCount()).toBe(n);
  });

  it('R73: the replacement must be a spare: not retired and not the moving drive itself', () => {
    const { a, b } = setup();
    moveDrive(db(), a.id, { destination: { kind: 'retire', reason: 'failed' } });
    const n = eventCount();
    expect(
      thrown(() =>
        moveDrive(db(), b.id, { destination: { kind: 'spares' }, replacement: { driveId: a.id } }),
      ).code,
    ).toBe('invalid');
    expect(
      thrown(() =>
        moveDrive(db(), b.id, { destination: { kind: 'spares' }, replacement: { driveId: b.id } }),
      ).code,
    ).toBe('invalid');
    expect(getDrive(db(), b.id).status).toBe('installed');
    expect(eventCount()).toBe(n);
  });

  it('R73: an installed drive cannot be the replacement', () => {
    const { a, b } = setup();
    expect(
      thrown(() =>
        moveDrive(db(), a.id, { destination: { kind: 'spares' }, replacement: { driveId: b.id } }),
      ).code,
    ).toBe('conflict');
  });

  it('R73, R14: a failing step leaves nothing changed (unknown pool for the replacement)', () => {
    const { a, s1, s3 } = setup();
    const c = spare('C');
    const n = eventCount();
    const memberRows = db().select().from(memberships).all();
    for (const destination of [
      { kind: 'spares' as const },
      { kind: 'slot' as const, slotId: s3 },
      { kind: 'retire' as const, reason: 'failed' as const },
    ]) {
      const err = thrown(() =>
        moveDrive(db(), a.id, { destination, replacement: { driveId: c.id, poolId: 'no-pool' } }),
      );
      expect(err.code).toBe('not-found');
    }
    expect(getDrive(db(), a.id)).toMatchObject({ status: 'installed', slotId: s1 });
    expect(getDrive(db(), c.id).status).toBe('spare');
    expect(eventCount()).toBe(n);
    expect(db().select().from(memberships).all()).toEqual(memberRows);
  });
});

describe('R73: POST /api/drives/:id/move', () => {
  const post = (id: string, payload: unknown) =>
    app.inject({ method: 'POST', url: `/api/drives/${id}/move`, payload: payload as object });

  it('R73: moves between bays and returns the drive', async () => {
    const { a, s3 } = setup();
    const res = await post(a.id, { destination: { kind: 'slot', slotId: s3 }, date: daysAgo(1) });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ drive: { id: a.id, slotId: s3 } });
  });

  it('R73, R37: an occupied bay is a 409 carrying the occupant', async () => {
    const { a, s2, b } = setup();
    const res = await post(a.id, { destination: { kind: 'slot', slotId: s2 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error.details).toEqual({ occupant: { driveId: b.id, serial: 'B' } });
  });

  it('R73: bad bodies are 400s (unknown kind, unknown keys, bad date, retire without a reason)', async () => {
    const { a } = setup();
    expect((await post(a.id, { destination: { kind: 'teleport' } })).statusCode).toBe(400);
    expect((await post(a.id, { destination: { kind: 'spares' }, extra: 1 })).statusCode).toBe(400);
    expect((await post(a.id, { destination: { kind: 'spares' }, date: 'soon' })).statusCode).toBe(
      400,
    );
    expect(
      (await post(a.id, { destination: { kind: 'spares' }, date: daysAgo(-3) })).statusCode,
    ).toBe(400);
    expect((await post(a.id, { destination: { kind: 'retire' } })).statusCode).toBe(400);
    expect((await post(a.id, {})).statusCode).toBe(400);
    expect(getDrive(db(), a.id).status).toBe('installed');
  });

  it('R73: a not-installed drive is a 409, an unknown one a 404', async () => {
    setup();
    const c = spare('C');
    expect((await post(c.id, { destination: { kind: 'spares' } })).statusCode).toBe(409);
    expect((await post('nope', { destination: { kind: 'spares' } })).statusCode).toBe(404);
  });
});

describe('R73: swap two installed drives', () => {
  const swapTo = (slotId: string) => ({
    kind: 'slot' as const,
    slotId,
    occupant: { action: 'swap' as const },
  });

  it('R73: the drives trade bays, memberships untouched, four events, one date for both', () => {
    const { a, b, s1, s2, pool } = setup();
    const before = [log(a.id).length, log(b.id).length];
    const memberRows = db().select().from(memberships).all();
    const result = moveDrive(db(), a.id, { destination: swapTo(s2), date: daysAgo(4) });
    expect(result.drive).toMatchObject({ id: a.id, slotId: s2, status: 'installed' });
    expect(result.occupant).toMatchObject({ id: b.id, slotId: s1, status: 'installed' });
    expect(getDrive(db(), a.id).installedOn).toBe(daysAgo(4));
    expect(getDrive(db(), b.id).installedOn).toBe(daysAgo(4));
    expect(db().select().from(memberships).all()).toEqual(memberRows);
    expect(members(a.id)[0]).toMatchObject({ poolId: pool, role: 'data', endedAt: null });
    expect(members(b.id)[0]).toMatchObject({ poolId: pool, role: 'hot-spare', endedAt: null });
    // R14, R74: ONE drives-swapped event for both drives and both bays.
    expect(log(a.id)).toHaveLength(before[0]! + 1);
    expect(log(b.id)).toHaveLength(before[1]! + 1);
    const swapped = ofType(a.id, 'drives-swapped');
    expect(swapped).toHaveLength(1);
    expect(ofType(b.id, 'drives-swapped')[0]!.id).toBe(swapped[0]!.id);
    expect(ofType(a.id, 'drive-removed')).toHaveLength(0);
    expect(driveLinks(swapped[0]!)).toEqual(
      [
        { driveId: a.id, role: 'subject' },
        { driveId: b.id, role: 'subject' },
      ].sort((x, y) => x.driveId.localeCompare(y.driveId)),
    );
    // Both bays are linked as `from` AND `to`.
    expect(slotLinks(swapped[0]!)).toEqual(
      [
        { slotId: s1, role: 'from' },
        { slotId: s2, role: 'from' },
        { slotId: s1, role: 'to' },
        { slotId: s2, role: 'to' },
      ].sort((x, y) => x.role.localeCompare(y.role) || x.slotId.localeCompare(y.slotId)),
    );
    expect(swapped[0]!.payload).toMatchObject({
      date: daysAgo(4),
      moves: [
        { driveId: a.id, fromSlotId: s1, toSlotId: s2, poolId: pool, role: 'data' },
        { driveId: b.id, fromSlotId: s2, toSlotId: s1, poolId: pool, role: 'hot-spare' },
      ],
    });
  });

  it('R73: omitted date is today, null is not recorded', () => {
    const { a, b, s2, s1 } = setup();
    moveDrive(db(), a.id, { destination: swapTo(s2) });
    expect(getDrive(db(), a.id).installedOn).toBe(TODAY());
    expect(getDrive(db(), b.id).installedOn).toBe(TODAY());
    moveDrive(db(), a.id, { destination: swapTo(s1), date: null });
    expect(getDrive(db(), a.id)).toMatchObject({ slotId: s1, installedOn: null });
    expect(getDrive(db(), b.id)).toMatchObject({ slotId: s2, installedOn: null });
    expect(ofType(b.id, 'drives-swapped')[0]!.payload).toMatchObject({ date: null });
  });

  it('R73: a date before either drive was installed, or in the future, is rejected', () => {
    const { a, b, s2 } = setup();
    const n = eventCount();
    const attempt = (date: string) => () =>
      moveDrive(db(), a.id, { destination: swapTo(s2), date });
    expect(thrown(attempt(daysAgo(90))).code).toBe('invalid');
    expect(thrown(attempt(daysAgo(-2))).code).toBe('invalid');
    expect(getDrive(db(), b.id).slotId).toBe(s2);
    expect(eventCount()).toBe(n);
  });

  it('R73: a replacement, the same bay or an empty bay is rejected', () => {
    const { a, s1, s2, s3 } = setup();
    const c = spare('C');
    const replaced = () =>
      moveDrive(db(), a.id, { destination: swapTo(s2), replacement: { driveId: c.id } });
    expect(thrown(replaced).code).toBe('invalid');
    expect(thrown(() => moveDrive(db(), a.id, { destination: swapTo(s1) })).code).toBe('invalid');
    expect(thrown(() => moveDrive(db(), a.id, { destination: swapTo(s3) })).code).toBe('invalid');
  });

  it('R73, R14: a swap that fails part way leaves nothing changed', () => {
    const { a, b, s1, s2 } = setup();
    const n = eventCount();
    const memberRows = db().select().from(memberships).all();
    opened.sqlite.exec(
      "CREATE TRIGGER fail_swap BEFORE INSERT ON events WHEN NEW.type = 'drives-swapped' BEGIN SELECT RAISE(ABORT, 'boom'); END",
    );
    expect(() => moveDrive(db(), a.id, { destination: swapTo(s2) })).toThrow();
    expect(getDrive(db(), a.id)).toMatchObject({
      status: 'installed',
      slotId: s1,
      installedOn: daysAgo(60),
    });
    expect(getDrive(db(), b.id)).toMatchObject({
      status: 'installed',
      slotId: s2,
      installedOn: daysAgo(60),
    });
    expect(eventCount()).toBe(n);
    expect(db().select().from(memberships).all()).toEqual(memberRows);
  });

  it('R73: POST swaps (200); a replacement or the swap action on assign is a 400', async () => {
    const { a, b, s2 } = setup();
    const c = spare('C');
    const post = (url: string, payload: object) => app.inject({ method: 'POST', url, payload });
    const bad = await post(`/api/drives/${a.id}/move`, {
      destination: swapTo(s2),
      replacement: { driveId: c.id },
    });
    expect(bad.statusCode).toBe(400);
    const plain = await post(`/api/slots/${s2}/assign`, {
      driveId: c.id,
      occupant: { action: 'swap' },
    });
    expect(plain.statusCode).toBe(400);
    const ok = await post(`/api/drives/${a.id}/move`, { destination: swapTo(s2) });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ drive: { id: a.id, slotId: s2 }, occupant: { id: b.id } });
  });
});
