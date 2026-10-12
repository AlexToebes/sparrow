import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { assignDrive } from '../src/core/assignment.js';
import { createDrive, getDrive } from '../src/core/drives.js';
import { DomainError } from '../src/core/errors.js';
import { createLayoutService } from '../src/core/layout.js';
import { moveDrive } from '../src/core/move.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { activities, events, installations, pools } from '../src/db/schema.js';
import {
  byDrive,
  countActivities,
  eventsOfDrive,
  lastActivity,
  ofType,
  shape,
} from './activity-helpers.js';

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
const eventCount = () => db().select().from(events).all().length;
const activityCount = () => db().select().from(activities).all().length;
const rows = () => db().select().from(installations).all();
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
  it('R73, R69: goes back to spares with the move date as the activity date', () => {
    const { a, s1, pool } = setup();
    const before = countActivities(db());
    const result = moveDrive(db(), a.id, { destination: { kind: 'spares' }, date: daysAgo(3) });
    expect(result.drive).toMatchObject({ status: 'spare', slotId: null, poolId: null });
    expect(countActivities(db())).toBe(before + 1);
    const act = lastActivity(db());
    expect(act).toMatchObject({ kind: 'moved', occurredOn: daysAgo(3) });
    expect(shape(act)).toEqual(['drive-uninstalled']);
    expect(act.events[0]).toMatchObject({ driveId: a.id, slotId: s1, poolId: pool });
    expect(act.events[0]!.payload).toEqual({ installedOn: daysAgo(60), poolRole: 'data' });
    expect(rows().some((r) => r.driveId === a.id)).toBe(false);
  });

  it('R73, R35, R60: with a spare taking its place, in ONE activity; defaults come from the vacated bay', () => {
    const { a, s1, pool } = setup();
    const c = spare('C');
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'spares' },
      replacement: { driveId: c.id },
      date: daysAgo(2),
    });
    expect(result.replacement).toMatchObject({ id: c.id, status: 'installed', slotId: s1 });
    expect(getDrive(db(), c.id)).toMatchObject({
      installedOn: daysAgo(2),
      poolId: pool,
      poolRole: 'data',
    });
    const act = lastActivity(db());
    expect(act.kind).toBe('moved');
    expect(byDrive(act)).toEqual([
      [a.id, 'drive-uninstalled'],
      [c.id, 'drive-installed'],
    ]);
    expect(act.events[1]).toMatchObject({ slotId: s1, poolId: pool });
    expect(act.events[1]!.payload).toEqual({ poolRole: 'data' });
  });

  it('R73: omitted date is today; null records no date for any step', () => {
    const { a, b } = setup();
    const c = spare('C');
    const d = spare('D');
    moveDrive(db(), a.id, { destination: { kind: 'spares' }, replacement: { driveId: c.id } });
    expect(getDrive(db(), c.id).installedOn).toBe(TODAY());
    expect(lastActivity(db()).occurredOn).toBe(TODAY());
    moveDrive(db(), b.id, {
      destination: { kind: 'spares' },
      replacement: { driveId: d.id },
      date: null,
    });
    expect(getDrive(db(), d.id).installedOn).toBeNull();
    expect(lastActivity(db()).occurredOn).toBeNull();
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
    expect(getDrive(db(), c.id)).toMatchObject({ poolId: other, poolRole: 'hot-spare' });
    moveDrive(db(), b.id, {
      destination: { kind: 'spares' },
      replacement: { driveId: d.id, poolId: null },
    });
    expect(getDrive(db(), d.id)).toMatchObject({ poolId: null, poolRole: null });
  });
});

describe('R73: retire and RMA', () => {
  it('R73, R60: retire without a replacement: uninstalled then drive-retired, dated by the move', () => {
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
    const act = lastActivity(db());
    expect(act).toMatchObject({ kind: 'moved', occurredOn: daysAgo(4) });
    expect(shape(act)).toEqual(['drive-uninstalled', 'drive-retired']);
    expect(act.events[0]!.slotId).toBe(s1);
    expect(act.events[1]!.payload).toEqual({ reason: 'failed', note: 'clicking' });
  });

  it('R73: retiring with a replacement puts the spare in the vacated bay (same activity)', () => {
    const { a, s1 } = setup();
    const c = spare('C');
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'retire', reason: 'other' },
      replacement: { driveId: c.id },
    });
    expect(result.drive.status).toBe('retired');
    expect(getDrive(db(), c.id)).toMatchObject({ status: 'installed', slotId: s1 });
    expect(shape(lastActivity(db()))).toEqual([
      'drive-uninstalled',
      'drive-retired',
      'drive-installed',
    ]);
  });

  it('R73, R27: RMA writes the RMA event; with a replacement the spare takes the bay', () => {
    const { a, b } = setup();
    const c = spare('C');
    moveDrive(db(), a.id, { destination: { kind: 'rma', note: 'sent' }, date: daysAgo(1) });
    expect(getDrive(db(), a.id)).toMatchObject({ status: 'retired', retirementReason: 'failed' });
    const act = lastActivity(db());
    expect(shape(act)).toEqual(['drive-uninstalled', 'drive-sent-for-rma']);
    expect(act.events[1]!.payload).toEqual({ note: 'sent' });
    expect(act.occurredOn).toBe(daysAgo(1));
    moveDrive(db(), b.id, { destination: { kind: 'rma' }, replacement: { driveId: c.id } });
    expect(getDrive(db(), b.id).status).toBe('retired');
    expect(getDrive(db(), c.id).status).toBe('installed');
    expect(shape(lastActivity(db()))).toEqual([
      'drive-uninstalled',
      'drive-sent-for-rma',
      'drive-installed',
    ]);
  });

  it('R73, R60: a retire date of null is not recorded', () => {
    const { a } = setup();
    moveDrive(db(), a.id, { destination: { kind: 'retire', reason: 'failed' }, date: null });
    expect(getDrive(db(), a.id).retirementDate).toBeNull();
    expect(lastActivity(db()).occurredOn).toBeNull();
  });
});

describe('R73: move to another bay', () => {
  it('R73, R29: keeps the pool and role; ONE moved activity of uninstall + install, no pool events', () => {
    const { a, s1, s3, pool } = setup();
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'slot', slotId: s3 },
      date: daysAgo(5),
    });
    expect(result.drive).toMatchObject({
      status: 'installed',
      slotId: s3,
      installedOn: daysAgo(5),
      poolId: pool,
      poolRole: 'data',
    });
    const act = lastActivity(db());
    expect(act).toMatchObject({ kind: 'moved', occurredOn: daysAgo(5) });
    expect(shape(act)).toEqual(['drive-uninstalled', 'drive-installed']);
    expect(act.events[0]).toMatchObject({ driveId: a.id, slotId: s1, poolId: pool });
    expect(act.events[0]!.payload).toEqual({ installedOn: daysAgo(60), poolRole: 'data' });
    expect(act.events[1]).toMatchObject({ driveId: a.id, slotId: s3, poolId: pool });
    expect(act.events[1]!.payload).toEqual({ poolRole: 'data' });
    expect(eventsOfDrive(db(), a.id).filter((e) => e.type.startsWith('pool-'))).toEqual([]);
  });

  it('R73, R35: the vacated bay can take a spare in the same step (one activity, three events)', () => {
    const { a, s1, s3 } = setup();
    const c = spare('C');
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'slot', slotId: s3 },
      replacement: { driveId: c.id },
    });
    expect(result.drive.slotId).toBe(s3);
    expect(result.replacement).toMatchObject({ slotId: s1, status: 'installed' });
    // The default pool and role come from the drive that left, which kept its own.
    expect(getDrive(db(), c.id)).toMatchObject({ poolRole: 'data' });
    expect(getDrive(db(), a.id).poolId).not.toBeNull();
    const act = lastActivity(db());
    expect(act.kind).toBe('moved');
    expect(byDrive(act)).toEqual([
      [a.id, 'drive-uninstalled'],
      [a.id, 'drive-installed'],
      [c.id, 'drive-installed'],
    ]);
    expect(act.events.map((e) => e.slotId)).toEqual([s1, s3, s1]);
  });

  it('R73: an unrecorded date makes the new installation date null', () => {
    const { a, s3 } = setup();
    moveDrive(db(), a.id, { destination: { kind: 'slot', slotId: s3 }, date: null });
    expect(getDrive(db(), a.id).installedOn).toBeNull();
    expect(lastActivity(db()).occurredOn).toBeNull();
  });

  it('R73, R68: a move date before the installation date is rejected and nothing changes', () => {
    const { a, s1, s3 } = setup();
    const n = activityCount();
    const err = thrown(() =>
      moveDrive(db(), a.id, { destination: { kind: 'slot', slotId: s3 }, date: daysAgo(90) }),
    );
    expect(err.code).toBe('invalid');
    expect(getDrive(db(), a.id).slotId).toBe(s1);
    expect(activityCount()).toBe(n);
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

  it('R73, R37: occupant to spares: the occupant leaves on the move date, in the one activity', () => {
    const { a, b, s1, s2 } = setup();
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'slot', slotId: s2, occupant: { action: 'spare' } },
      date: daysAgo(2),
    });
    expect(result.drive.slotId).toBe(s2);
    expect(result.occupant).toMatchObject({ id: b.id, status: 'spare' });
    const act = lastActivity(db());
    expect(act).toMatchObject({ kind: 'moved', occurredOn: daysAgo(2) });
    expect(byDrive(act)).toEqual([
      [b.id, 'drive-uninstalled'],
      [a.id, 'drive-uninstalled'],
      [a.id, 'drive-installed'],
    ]);
    expect(act.events.map((e) => e.slotId)).toEqual([s2, s1, s2]);
    expect(getDrive(db(), b.id)).toMatchObject({ slotId: null, poolId: null });
  });

  it('R73, R74: into an occupied bay with a spare filling the vacated bay is still ONE activity', () => {
    const { a, b, s1, s2 } = setup();
    const c = spare('C');
    const before = activityCount();
    const result = moveDrive(db(), a.id, {
      destination: { kind: 'slot', slotId: s2, occupant: { action: 'retire', reason: 'failed' } },
      replacement: { driveId: c.id },
      date: daysAgo(2),
    });
    expect(result.drive.slotId).toBe(s2);
    expect(result.occupant).toMatchObject({ id: b.id, status: 'retired' });
    expect(result.replacement).toMatchObject({ id: c.id, slotId: s1 });
    expect(activityCount()).toBe(before + 1);
    const act = lastActivity(db());
    expect(byDrive(act)).toEqual([
      [b.id, 'drive-uninstalled'],
      [b.id, 'drive-retired'],
      [a.id, 'drive-uninstalled'],
      [a.id, 'drive-installed'],
      [c.id, 'drive-installed'],
    ]);
    expect(ofType(act, 'drive-retired')[0]!.payload).toEqual({ reason: 'failed', note: null });
  });

  it('R73, R37, R62: occupant retired with the chosen reason; the date is the move date', () => {
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
    expect(getDrive(db(), b.id)).toMatchObject({ status: 'retired', retirementDate: null });
    expect(shape(lastActivity(db()))).toContain('drive-sent-for-rma');
  });

  it('R69, R73: a differing date on the occupant resolution is a 400, the same day is fine', () => {
    const { a, b, s2 } = setup();
    const n = activityCount();
    const err = thrown(() =>
      moveDrive(db(), a.id, {
        destination: {
          kind: 'slot',
          slotId: s2,
          occupant: { action: 'retire', reason: 'failed', date: daysAgo(10) },
        },
        date: daysAgo(1),
      }),
    );
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/same day as the replacement/);
    expect(getDrive(db(), b.id).status).toBe('installed');
    expect(activityCount()).toBe(n);
    moveDrive(db(), a.id, {
      destination: {
        kind: 'slot',
        slotId: s2,
        occupant: { action: 'retire', reason: 'failed', date: daysAgo(1) },
      },
      date: daysAgo(1),
    });
    expect(getDrive(db(), b.id).retirementDate).toBe(daysAgo(1));
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
    const before = rows();
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
    expect(rows()).toEqual(before);
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

  it('R73: the drives trade bays, keeping pool and role; ONE `swapped` activity of four events, one date for both', () => {
    const { a, b, s1, s2, pool } = setup();
    const before = activityCount();
    const result = moveDrive(db(), a.id, { destination: swapTo(s2), date: daysAgo(4) });
    expect(result.drive).toMatchObject({ id: a.id, slotId: s2, status: 'installed' });
    expect(result.occupant).toMatchObject({ id: b.id, slotId: s1, status: 'installed' });
    expect(getDrive(db(), a.id)).toMatchObject({
      installedOn: daysAgo(4),
      poolId: pool,
      poolRole: 'data',
    });
    expect(getDrive(db(), b.id)).toMatchObject({
      installedOn: daysAgo(4),
      poolId: pool,
      poolRole: 'hot-spare',
    });
    expect(activityCount()).toBe(before + 1);
    const act = lastActivity(db());
    expect(act).toMatchObject({ kind: 'swapped', occurredOn: daysAgo(4) });
    expect(byDrive(act)).toEqual([
      [a.id, 'drive-uninstalled'],
      [b.id, 'drive-uninstalled'],
      [a.id, 'drive-installed'],
      [b.id, 'drive-installed'],
    ]);
    expect(act.events.map((e) => e.slotId)).toEqual([s1, s2, s2, s1]);
    expect(act.events[3]!.payload).toEqual({ poolRole: 'hot-spare' });
  });

  it('R73: omitted date is today, null is not recorded', () => {
    const { a, b, s2, s1 } = setup();
    moveDrive(db(), a.id, { destination: swapTo(s2) });
    expect(getDrive(db(), a.id).installedOn).toBe(TODAY());
    expect(getDrive(db(), b.id).installedOn).toBe(TODAY());
    moveDrive(db(), a.id, { destination: swapTo(s1), date: null });
    expect(getDrive(db(), a.id)).toMatchObject({ slotId: s1, installedOn: null });
    expect(getDrive(db(), b.id)).toMatchObject({ slotId: s2, installedOn: null });
    expect(lastActivity(db()).occurredOn).toBeNull();
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
    const before = rows();
    opened.sqlite.exec(
      "CREATE TRIGGER fail_swap BEFORE INSERT ON events WHEN NEW.type = 'drive-installed' AND NEW.ord = 3 BEGIN SELECT RAISE(ABORT, 'boom'); END",
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
    expect(rows()).toEqual(before);
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
