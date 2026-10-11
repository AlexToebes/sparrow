import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq, like } from 'drizzle-orm';
import { assignDrive, removeToSpares, retireDrive, sendForRma } from '../src/core/assignment.js';
import { createDrive, getDrive } from '../src/core/drives.js';
import { DomainError } from '../src/core/errors.js';
import { listDriveEvents } from '../src/core/events.js';
import { createLayoutService } from '../src/core/layout.js';
import { createPool, deletePool, getPool, listPools, updatePool } from '../src/core/pools.js';
import { changeMembership, joinPool, leavePool, listMemberships } from '../src/core/memberships.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { events, memberships } from '../src/db/schema.js';

let opened: OpenedDatabase;
beforeEach(() => {
  opened = openDatabase(':memory:');
});
afterEach(() => opened.sqlite.close());

const db = () => opened.db;
const spare = (serial: string) => createDrive(db(), { serial });
const types = (id: string) => listDriveEvents(db(), id).map((e) => e.type);
const eventsOf = (id: string, type: string) =>
  listDriveEvents(db(), id).filter((e) => e.type === type);
const rows = (driveId: string) =>
  db().select().from(memberships).where(eq(memberships.driveId, driveId)).all();

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
  return { slots: slots.map((s) => s.id) };
}

function thrown(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (err) {
    if (err instanceof DomainError) return err;
    throw err;
  }
  throw new Error('expected a DomainError');
}

/** Installs a fresh spare in a slot, optionally with a pool, and returns the drive id. */
function install(serial: string, slotId: string, poolId?: string | null) {
  const d = spare(serial);
  assignDrive(db(), { driveId: d.id, slotId, poolId });
  return d.id;
}

describe('pool CRUD (R30)', () => {
  it('creates a pool with a name and layout label, trimming the name', () => {
    const pool = createPool(db(), { name: '  tank ', layoutLabel: 'raidz2' });
    expect(pool).toMatchObject({ name: 'tank', layoutLabel: 'raidz2' });
    expect(getPool(db(), pool.id)).toMatchObject({ id: pool.id, name: 'tank', members: [] });
  });

  it('creates a pool without a layout label', () => {
    expect(createPool(db(), { name: 'scratch' }).layoutLabel).toBeNull();
  });

  it('duplicate name is a conflict on create and on rename', () => {
    createPool(db(), { name: 'tank' });
    const err = thrown(() => createPool(db(), { name: 'tank' }));
    expect(err.code).toBe('conflict');
    const other = createPool(db(), { name: 'backup' });
    const rename = thrown(() => updatePool(db(), other.id, { name: 'tank' }));
    expect(rename.code).toBe('conflict');
  });

  it('updates name and layout label; renaming a pool keeps its memberships', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    const updated = updatePool(db(), pool.id, { name: 'vault', layoutLabel: 'mirror' });
    expect(updated).toMatchObject({ name: 'vault', layoutLabel: 'mirror' });
    expect(getPool(db(), pool.id).members.map((m) => m.driveId)).toEqual([driveId]);
  });

  it('R75: pool create, update and delete write events with no drive', () => {
    const pool = createPool(db(), { name: 'tank', expectedMembers: 6 });
    updatePool(db(), pool.id, { layoutLabel: 'raidz1', expectedMembers: 4 });
    updatePool(db(), pool.id, { layoutLabel: 'raidz1' }); // no-op: no event
    deletePool(db(), pool.id);
    const rows = db().select().from(events).where(like(events.type, 'pool-%')).all();
    expect(rows.every((e) => e.driveId === null)).toBe(true);
    const byType = (t: string) => rows.filter((e) => e.type === t);
    expect(byType('pool-created')).toHaveLength(1);
    expect(byType('pool-created')[0]!.payload).toMatchObject({ poolId: pool.id, name: 'tank' });
    expect(byType('pool-updated')).toHaveLength(1);
    expect(byType('pool-updated')[0]!.payload).toMatchObject({
      poolId: pool.id,
      changes: {
        layoutLabel: { from: null, to: 'raidz1' },
        expectedMembers: { from: 6, to: 4 },
      },
    });
    expect(byType('pool-deleted')[0]!.payload).toMatchObject({ poolId: pool.id, name: 'tank' });
  });

  it('R75: a refused pool delete or rename writes no event', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    install('A', slots[0]!, pool.id);
    const other = createPool(db(), { name: 'other' });
    const count = () => db().select().from(events).where(like(events.type, 'pool-%')).all().length;
    const before = count();
    expect(thrown(() => deletePool(db(), pool.id)).code).toBe('conflict');
    expect(thrown(() => updatePool(db(), other.id, { name: 'tank' })).code).toBe('conflict');
    expect(count()).toBe(before);
  });

  it('R34: sizeCheck compares current members with the expected count', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    expect(getPool(db(), pool.id).sizeCheck).toBeNull();
    updatePool(db(), pool.id, { expectedMembers: 2 });
    expect(listPools(db())[0]).toMatchObject({
      expectedMembers: 2,
      memberCount: 0,
      sizeCheck: 'fewer',
    });
    install('A', slots[0]!, pool.id);
    install('B', slots[1]!, pool.id);
    expect(getPool(db(), pool.id)).toMatchObject({ memberCount: 2, sizeCheck: 'ok' });
    install('C', slots[2]!, pool.id);
    expect(getPool(db(), pool.id)).toMatchObject({ memberCount: 3, sizeCheck: 'more' });
    updatePool(db(), pool.id, { expectedMembers: null });
    expect(getPool(db(), pool.id).sizeCheck).toBeNull();
  });

  it('listPools includes the current member count', () => {
    const { slots } = setup();
    const tank = createPool(db(), { name: 'tank' });
    createPool(db(), { name: 'empty' });
    install('A', slots[0]!, tank.id);
    install('B', slots[1]!, tank.id);
    const list = listPools(db());
    expect(list.map((p) => [p.name, p.memberCount])).toEqual([
      ['empty', 0],
      ['tank', 2],
    ]);
  });

  it('unknown pool is not-found for get, update and delete', () => {
    expect(thrown(() => getPool(db(), 'nope')).code).toBe('not-found');
    expect(thrown(() => updatePool(db(), 'nope', { name: 'x' })).code).toBe('not-found');
    expect(thrown(() => deletePool(db(), 'nope')).code).toBe('not-found');
  });

  it('deletes a pool that never had a membership', () => {
    const pool = createPool(db(), { name: 'unused' });
    deletePool(db(), pool.id);
    expect(listPools(db())).toEqual([]);
  });

  it('delete is blocked by history: a pool that once had a member cannot be deleted', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    removeToSpares(db(), driveId);
    const err = thrown(() => deletePool(db(), pool.id));
    expect(err.code).toBe('conflict');
    expect(getPool(db(), pool.id).name).toBe('tank');
  });
});

describe('assignment-time membership (R35, R33)', () => {
  it('assign with a pool shows up in listMemberships with role and source manual', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    expect(listMemberships(db(), driveId)).toEqual([
      expect.objectContaining({
        driveId,
        poolId: pool.id,
        role: 'data',
        source: 'manual',
        endedAt: null,
      }),
    ]);
  });

  it('getPool lists the installed member with its slot label', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    const detail = getPool(db(), pool.id);
    expect(detail.members).toEqual([
      expect.objectContaining({
        driveId,
        serial: 'A',
        role: 'data',
        slotLabel: 'Slot 1',
        startedAt: expect.any(String),
      }),
    ]);
  });
});

describe('join (R29, R33)', () => {
  it('joins an installed drive, writes pool-joined and keeps the given start date', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!);
    const m = joinPool(db(), driveId, {
      poolId: pool.id,
      role: 'hot-spare',
      startedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(m).toMatchObject({
      poolId: pool.id,
      role: 'hot-spare',
      startedAt: '2026-01-02T03:04:05.000Z',
      endedAt: null,
      source: 'manual',
    });
    expect(eventsOf(driveId, 'pool-joined')[0]!.payload).toMatchObject({
      poolId: pool.id,
      role: 'hot-spare',
      slotId: slots[0],
    });
  });

  it('R29: rejects a start date in the future (beyond clock skew)', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!);
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    expect(thrown(() => joinPool(db(), driveId, { poolId: pool.id, startedAt: future })).code).toBe(
      'invalid',
    );
    expect(listMemberships(db(), driveId)).toHaveLength(0);
    const nearly = new Date(Date.now() + 60_000).toISOString(); // within tolerance
    expect(joinPool(db(), driveId, { poolId: pool.id, startedAt: nearly }).startedAt).toBe(nearly);
  });

  it('R33: a user-supplied start date goes into the payload while the event stays stamped now', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!);
    const before = Date.now();
    joinPool(db(), driveId, { poolId: pool.id, startedAt: '2026-01-02T03:04:05.000Z' });
    const ev = eventsOf(driveId, 'pool-joined')[0]!;
    expect(Date.parse(ev.at)).toBeGreaterThanOrEqual(before);
    expect(ev.payload.startedAt).toBe('2026-01-02T03:04:05.000Z');
  });

  it('R29: rejects an end date in the future; a past one is kept in the payload', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!);
    joinPool(db(), driveId, { poolId: pool.id, startedAt: '2026-01-02T03:04:05.000Z' });
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    expect(thrown(() => leavePool(db(), driveId, { endedAt: future })).code).toBe('invalid');
    expect(eventsOf(driveId, 'pool-left')).toHaveLength(0);
    leavePool(db(), driveId, { endedAt: '2026-02-03T00:00:00.000Z' });
    expect(eventsOf(driveId, 'pool-left')[0]!.payload.endedAt).toBe('2026-02-03T00:00:00.000Z');
  });

  it('role defaults to data and start date to now', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!);
    const m = joinPool(db(), driveId, { poolId: pool.id });
    expect(m.role).toBe('data');
    expect(Date.parse(m.startedAt)).not.toBeNaN();
  });

  it('a second open membership is a conflict that points to change', () => {
    const { slots } = setup();
    const a = createPool(db(), { name: 'a' });
    const b = createPool(db(), { name: 'b' });
    const driveId = install('A', slots[0]!, a.id);
    const err = thrown(() => joinPool(db(), driveId, { poolId: b.id }));
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/change/);
    expect(rows(driveId)).toHaveLength(1);
  });

  it('R8/R33: joining while spare is rejected and changes nothing', () => {
    const pool = createPool(db(), { name: 'tank' });
    const d = spare('SP');
    const err = thrown(() => joinPool(db(), d.id, { poolId: pool.id }));
    expect(err.code).toBe('conflict');
    expect(rows(d.id)).toEqual([]);
    expect(types(d.id)).toEqual(['drive-created']);
  });

  it('joining a retired drive is rejected', () => {
    const pool = createPool(db(), { name: 'tank' });
    const d = spare('RT');
    retireDrive(db(), d.id, { reason: 'failed' });
    expect(thrown(() => joinPool(db(), d.id, { poolId: pool.id })).code).toBe('conflict');
  });

  it('unknown drive or pool is not-found', () => {
    const { slots } = setup();
    const driveId = install('A', slots[0]!);
    expect(thrown(() => joinPool(db(), 'nope', { poolId: 'x' })).code).toBe('not-found');
    expect(thrown(() => joinPool(db(), driveId, { poolId: 'nope' })).code).toBe('not-found');
  });
});

describe('later edits: role and pool change (R29, R36)', () => {
  it('role change on the same pool updates the open membership, keeps startedAt, logs pool-role-changed', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    const before = listMemberships(db(), driveId)[0]!;
    const after = changeMembership(db(), driveId, { role: 'hot-spare' });
    expect(after).toMatchObject({
      id: before.id,
      poolId: pool.id,
      role: 'hot-spare',
      startedAt: before.startedAt,
      endedAt: null,
    });
    expect(listMemberships(db(), driveId)).toHaveLength(1);
    expect(eventsOf(driveId, 'pool-role-changed')[0]!.payload).toMatchObject({
      poolId: pool.id,
      from: 'data',
      to: 'hot-spare',
    });
  });

  it('same role on the same pool is a no-op with no event', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    const count = listDriveEvents(db(), driveId).length;
    changeMembership(db(), driveId, { poolId: pool.id, role: 'data' });
    expect(listDriveEvents(db(), driveId)).toHaveLength(count);
  });

  it('pool change ends the old membership (pool-left) and opens a new one (pool-joined)', () => {
    const { slots } = setup();
    const a = createPool(db(), { name: 'a' });
    const b = createPool(db(), { name: 'b' });
    const driveId = install('A', slots[0]!, a.id);
    const old = listMemberships(db(), driveId)[0]!;
    const next = changeMembership(db(), driveId, { poolId: b.id });
    expect(next).toMatchObject({ poolId: b.id, role: 'data', endedAt: null });
    const history = listMemberships(db(), driveId);
    expect(history.map((m) => [m.poolId, m.endedAt === null])).toEqual([
      [b.id, true],
      [a.id, false],
    ]);
    expect(history[1]!.id).toBe(old.id);
    expect(history[1]!.endedAt).not.toBeNull();
    expect(eventsOf(driveId, 'pool-left')[0]!.payload).toMatchObject({ poolId: a.id });
    expect(eventsOf(driveId, 'pool-joined')[0]!.payload).toMatchObject({ poolId: b.id });
  });

  it('pool change can also set a new role', () => {
    const { slots } = setup();
    const a = createPool(db(), { name: 'a' });
    const b = createPool(db(), { name: 'b' });
    const driveId = install('A', slots[0]!, a.id);
    const next = changeMembership(db(), driveId, { poolId: b.id, role: 'hot-spare' });
    expect(next.role).toBe('hot-spare');
  });

  it('change with no open membership is a conflict (join first)', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!);
    expect(thrown(() => changeMembership(db(), driveId, { role: 'data' })).code).toBe('conflict');
    expect(thrown(() => changeMembership(db(), driveId, { poolId: pool.id })).code).toBe(
      'conflict',
    );
  });

  it('change to an unknown pool is not-found and changes nothing', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    expect(thrown(() => changeMembership(db(), driveId, { poolId: 'nope' })).code).toBe(
      'not-found',
    );
    expect(listMemberships(db(), driveId)).toHaveLength(1);
  });
});

describe('leave and history (R29, R33)', () => {
  it('leavePool ends the membership, logs pool-left, keeps the row', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    const ended = leavePool(db(), driveId);
    expect(ended.endedAt).not.toBeNull();
    expect(ended.endedAt! >= ended.startedAt).toBe(true);
    expect(listMemberships(db(), driveId)).toHaveLength(1);
    expect(eventsOf(driveId, 'pool-left')).toHaveLength(1);
    expect(getDrive(db(), driveId).status).toBe('installed');
  });

  it('leave with an endedAt before the start is clamped to the start (CHECK holds)', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!);
    const m = joinPool(db(), driveId, { poolId: pool.id, startedAt: '2026-03-01T00:00:00.000Z' });
    const ended = leavePool(db(), driveId, { endedAt: '2026-02-01T00:00:00.000Z' });
    expect(ended.endedAt).toBe(m.startedAt);
  });

  it('leave with no open membership is a conflict', () => {
    const { slots } = setup();
    const driveId = install('A', slots[0]!);
    expect(thrown(() => leavePool(db(), driveId)).code).toBe('conflict');
  });

  it('history is kept when a drive is removed to spares', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    removeToSpares(db(), driveId);
    expect(listMemberships(db(), driveId)).toHaveLength(1);
    expect(listMemberships(db(), driveId)[0]!.endedAt).not.toBeNull();
    expect(types(driveId)).toContain('pool-left');
  });

  it('history is kept when a drive is retired from an installed slot', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    retireDrive(db(), driveId, { reason: 'failed', date: '2026-05-01' });
    const history = listMemberships(db(), driveId);
    expect(history).toHaveLength(1);
    expect(history[0]!.endedAt).not.toBeNull();
    expect(getPool(db(), pool.id).members).toEqual([]);
  });

  it('history is kept after RMA', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    sendForRma(db(), driveId);
    expect(listMemberships(db(), driveId)).toHaveLength(1);
    expect(listMemberships(db(), driveId)[0]!.endedAt).not.toBeNull();
  });

  it('listMemberships returns the full history newest first, and 404s on an unknown drive', () => {
    const { slots } = setup();
    const a = createPool(db(), { name: 'a' });
    const b = createPool(db(), { name: 'b' });
    const driveId = install('A', slots[0]!, a.id);
    changeMembership(db(), driveId, { poolId: b.id });
    leavePool(db(), driveId);
    const history = listMemberships(db(), driveId);
    expect(history.map((m) => m.poolId)).toEqual([b.id, a.id]);
    expect(thrown(() => listMemberships(db(), 'nope')).code).toBe('not-found');
  });

  it('a failing event write rolls back the membership change', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!);
    opened.sqlite.exec(`
      CREATE TRIGGER fail_pool_joined BEFORE INSERT ON events
      WHEN NEW.type = 'pool-joined'
      BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `);
    expect(() => joinPool(db(), driveId, { poolId: pool.id })).toThrow(/boom/);
    expect(rows(driveId)).toEqual([]);
  });
});
