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
    const { a } = setup();
    const result = moveDrive(db(), a.id, { destination: { kind: 'spares' }, date: daysAgo(3) });
    expect(result.drive).toMatchObject({ status: 'spare', slotId: null });
    expect(ofType(a.id, 'drive-removed')[0]!.payload).toMatchObject({ removedOn: daysAgo(3) });
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
    expect(ofType(c.id, 'drive-installed')[0]!.payload).toMatchObject({
      slotId: s1,
      poolId: pool,
      installedOn: daysAgo(2),
    });
    expect(ofType(c.id, 'pool-joined')).toHaveLength(1);
  });

  it('R73: omitted date is today; null records no date for any step', () => {
    const { a, b } = setup();
    const c = spare('C');
    const d = spare('D');
    moveDrive(db(), a.id, { destination: { kind: 'spares' }, replacement: { driveId: c.id } });
    expect(getDrive(db(), c.id).installedOn).toBe(TODAY());
    expect(ofType(a.id, 'drive-removed')[0]!.payload).toMatchObject({ removedOn: TODAY() });
    moveDrive(db(), b.id, {
      destination: { kind: 'spares' },
      replacement: { driveId: d.id },
      date: null,
    });
    expect(getDrive(db(), d.id).installedOn).toBeNull();
    expect(ofType(b.id, 'drive-removed')[0]!.payload).toMatchObject({ removedOn: null });
    expect(ofType(d.id, 'drive-installed')[0]!.payload).toMatchObject({ installedOn: null });
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
    const { a } = setup();
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'retire', reason: 'failed', note: 'clicking' },
      date: daysAgo(4),
    });
    expect(result.drive).toMatchObject({
      status: 'retired',
      retirementReason: 'failed',
      retirementDate: daysAgo(4),
      retirementNote: 'clicking',
      replacedByDriveId: null,
    });
    expect(ofType(a.id, 'drive-removed')[0]!.payload).toMatchObject({ removedOn: daysAgo(4) });
    expect(ofType(a.id, 'drive-retired')).toHaveLength(1);
    expect(ofType(a.id, 'pool-left')).toHaveLength(1);
  });

  it('R73, R62: retiring with a replacement sets replaced-by to it, whatever the reason', () => {
    const { a, s1 } = setup();
    const c = spare('C');
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'retire', reason: 'other' },
      replacement: { driveId: c.id },
    });
    expect(result.drive.replacedByDriveId).toBe(c.id);
    expect(getDrive(db(), c.id)).toMatchObject({ status: 'installed', slotId: s1 });
    expect(ofType(a.id, 'drive-retired')[0]!.payload).toMatchObject({ replacedByDriveId: c.id });
  });

  it('R73, R27: RMA writes the RMA event; with a replacement it is linked as replaced-by', () => {
    const { a, b } = setup();
    const c = spare('C');
    moveDrive(db(), a.id, { destination: { kind: 'rma', note: 'sent' }, date: daysAgo(1) });
    expect(getDrive(db(), a.id)).toMatchObject({ status: 'retired', retirementReason: 'failed' });
    expect(ofType(a.id, 'drive-sent-for-rma')[0]!.payload).toMatchObject({
      date: daysAgo(1),
      note: 'sent',
    });
    moveDrive(db(), b.id, { destination: { kind: 'rma' }, replacement: { driveId: c.id } });
    expect(getDrive(db(), b.id).replacedByDriveId).toBe(c.id);
    expect(getDrive(db(), c.id).status).toBe('installed');
  });

  it('R73, R60: a retire date of null is not recorded', () => {
    const { a } = setup();
    moveDrive(db(), a.id, { destination: { kind: 'retire', reason: 'failed' }, date: null });
    expect(getDrive(db(), a.id).retirementDate).toBeNull();
    expect(ofType(a.id, 'drive-removed')[0]!.payload).toMatchObject({ removedOn: null });
  });
});

describe('R73: move to another bay', () => {
  it('R73, R29: keeps the open membership; writes removed + installed with moved* payloads, no pool events', () => {
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
    expect(ofType(a.id, 'drive-removed')[0]!.payload).toMatchObject({
      slotId: s1,
      poolId: pool,
      role: 'data',
      installedOn: daysAgo(60),
      removedOn: daysAgo(5),
      movedToSlotId: s3,
    });
    expect(ofType(a.id, 'drive-installed').at(0)!.payload).toMatchObject({
      slotId: s3,
      poolId: pool,
      role: 'data',
      installedOn: daysAgo(5),
      movedFromSlotId: s1,
    });
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
  });

  it('R73: an unrecorded date makes the new installation date null', () => {
    const { a, s3 } = setup();
    moveDrive(db(), a.id, { destination: { kind: 'slot', slotId: s3 }, date: null });
    expect(getDrive(db(), a.id).installedOn).toBeNull();
    expect(ofType(a.id, 'drive-removed')[0]!.payload).toMatchObject({ removedOn: null });
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
    const { a, b, s2 } = setup();
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'slot', slotId: s2, occupant: { action: 'spare' } },
      date: daysAgo(2),
    });
    expect(result.drive.slotId).toBe(s2);
    expect(result.occupant).toMatchObject({ id: b.id, status: 'spare' });
    expect(ofType(b.id, 'drive-removed')[0]!.payload).toMatchObject({ removedOn: daysAgo(2) });
    expect(members(b.id)[0]!.endedAt).not.toBeNull();
  });

  it('R73, R37, R62: occupant retired as replaced is replaced by the moving drive; dates follow the move', () => {
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
      replacedByDriveId: a.id,
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
    expect(ofType(b.id, 'drive-sent-for-rma')[0]!.payload).toMatchObject({ date: null });
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
    expect(log(a.id)).toHaveLength(before[0]! + 2);
    expect(log(b.id)).toHaveLength(before[1]! + 2);
    expect(ofType(a.id, 'drive-removed')[0]!.payload).toMatchObject({
      slotId: s1,
      removedOn: daysAgo(4),
      installedOn: daysAgo(60),
      movedToSlotId: s2,
      swappedWithDriveId: b.id,
    });
    expect(ofType(a.id, 'drive-installed')[0]!.payload).toMatchObject({
      slotId: s2,
      installedOn: daysAgo(4),
      movedFromSlotId: s1,
      swappedWithDriveId: b.id,
    });
    expect(ofType(b.id, 'drive-removed')[0]!.payload).toMatchObject({
      slotId: s2,
      movedToSlotId: s1,
      swappedWithDriveId: a.id,
    });
    expect(ofType(b.id, 'drive-installed')[0]!.payload).toMatchObject({
      slotId: s1,
      movedFromSlotId: s2,
      swappedWithDriveId: a.id,
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
    expect(ofType(b.id, 'drive-removed')[0]!.payload).toMatchObject({ removedOn: null });
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
      `CREATE TRIGGER fail_b BEFORE INSERT ON events WHEN NEW.drive_id = '${b.id}' AND NEW.type = 'drive-installed' BEGIN SELECT RAISE(ABORT, 'boom'); END`,
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
