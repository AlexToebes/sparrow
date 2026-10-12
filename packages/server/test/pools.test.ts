import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assignDrive, removeToSpares, retireDrive, sendForRma } from '../src/core/assignment.js';
import { listPoolActivities } from '../src/core/activities.js';
import { createDrive, getDrive } from '../src/core/drives.js';
import { DomainError } from '../src/core/errors.js';
import { createLayoutService } from '../src/core/layout.js';
import { createPool, deletePool, getPool, listPools, updatePool } from '../src/core/pools.js';
import { changeMembership, joinPool, leavePool } from '../src/core/memberships.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { activities, installations } from '../src/db/schema.js';
import {
  activitiesOf,
  countActivities,
  eventsOfDrive,
  lastActivity,
  shape,
} from './activity-helpers.js';

let opened: OpenedDatabase;
beforeEach(() => {
  opened = openDatabase(':memory:');
});
afterEach(() => opened.sqlite.close());

const db = () => opened.db;
const spare = (serial: string) => createDrive(db(), { serial });
const types = (id: string) => eventsOfDrive(db(), id).map((e) => e.type);
const eventsOf = (id: string, type: string) =>
  eventsOfDrive(db(), id).filter((e) => e.type === type);
const installationOf = (driveId: string) =>
  db()
    .select()
    .from(installations)
    .all()
    .find((i) => i.driveId === driveId);
const activityCount = () => db().select().from(activities).all().length;

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

  it('updates name and layout label; renaming a pool keeps its members', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    const updated = updatePool(db(), pool.id, { name: 'vault', layoutLabel: 'mirror' });
    expect(updated).toMatchObject({ name: 'vault', layoutLabel: 'mirror' });
    expect(getPool(db(), pool.id).members.map((m) => m.driveId)).toEqual([driveId]);
  });

  it('R75: pool create, update and delete are `pool-edited` activities whose events belong to the pool and no drive', () => {
    const pool = createPool(db(), { name: 'tank', expectedMembers: 6 });
    updatePool(db(), pool.id, { layoutLabel: 'raidz1', expectedMembers: 4 });
    updatePool(db(), pool.id, { layoutLabel: 'raidz1' }); // no-op: no activity
    deletePool(db(), pool.id);
    const acts = activitiesOf(db());
    expect(acts.map((a) => a.kind)).toEqual(['pool-edited', 'pool-edited', 'pool-edited']);
    const rows = acts.flatMap((a) => a.events);
    expect(rows.map((e) => e.type)).toEqual(['pool-created', 'pool-updated', 'pool-deleted']);
    expect(rows.map((e) => e.driveId)).toEqual([null, null, null]);
    // Each event names the pool by id and by the name it had then.
    expect(rows.map((e) => [e.poolId, e.poolName])).toEqual([
      [pool.id, 'tank'],
      [pool.id, 'tank'],
      [pool.id, 'tank'],
    ]);
    // Created and deleted carry the whole record; updated carries from/to for every changed field.
    expect(rows[0]!.payload).toMatchObject({
      id: pool.id,
      name: 'tank',
      layoutLabel: null,
      expectedMembers: 6,
    });
    expect(rows[1]!.payload).toEqual({
      changes: {
        layoutLabel: { from: null, to: 'raidz1' },
        expectedMembers: { from: 6, to: 4 },
      },
    });
    expect(rows[2]!.payload).toMatchObject({ id: pool.id, name: 'tank', expectedMembers: 4 });
  });

  it('R75: a refused pool delete or rename writes no activity', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    install('A', slots[0]!, pool.id);
    const other = createPool(db(), { name: 'other' });
    const before = activityCount();
    expect(thrown(() => deletePool(db(), pool.id)).code).toBe('conflict');
    expect(thrown(() => updatePool(db(), other.id, { name: 'tank' })).code).toBe('conflict');
    expect(activityCount()).toBe(before);
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

  it('deletes a pool that no installation references', () => {
    const pool = createPool(db(), { name: 'unused' });
    deletePool(db(), pool.id);
    expect(listPools(db())).toEqual([]);
  });

  it('R29 (changed 2026-10-12): delete is blocked only while a drive is installed in the pool; the history keeps the name', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    const err = thrown(() => deletePool(db(), pool.id));
    expect(err.code).toBe('conflict');
    expect(getPool(db(), pool.id).name).toBe('tank');

    removeToSpares(db(), driveId);
    deletePool(db(), pool.id);
    expect(listPools(db())).toEqual([]);
    // The drive's history still names the deleted pool (copied on its events).
    const installed = eventsOf(driveId, 'drive-installed')[0]!;
    expect(installed).toMatchObject({ poolId: pool.id, poolName: 'tank' });
    // And the pool's own history is still readable by its id.
    expect(listPoolActivities(db(), pool.id).length).toBeGreaterThanOrEqual(3);
  });
});

describe('assignment-time membership (R35, R33)', () => {
  it('assign with a pool sets the pool and role on the drive and its installation', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    expect(installationOf(driveId)).toMatchObject({
      driveId,
      slotId: slots[0],
      poolId: pool.id,
      poolRole: 'data',
    });
    expect(getDrive(db(), driveId)).toMatchObject({ poolId: pool.id, poolRole: 'data' });
  });

  it('getPool lists the installed member with its slot label and installation date', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    const detail = getPool(db(), pool.id);
    expect(detail.members).toEqual([
      {
        driveId,
        serial: 'A',
        capacityBytes: null,
        role: 'data',
        slotId: slots[0],
        slotLabel: 'Slot 1',
        installedOn: new Date().toISOString().slice(0, 10),
      },
    ]);
  });
});

describe('join (R29, R33)', () => {
  it('joins an installed drive: one `pool-joined` activity with one pool-joined event, dated by the given day', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!);
    const m = joinPool(db(), driveId, {
      poolId: pool.id,
      role: 'hot-spare',
      startedAt: '2026-01-02T03:04:05.000Z',
    });
    expect(m).toMatchObject({ driveId, poolId: pool.id, poolRole: 'hot-spare' });
    const act = lastActivity(db());
    expect(act).toMatchObject({ kind: 'pool-joined', occurredOn: '2026-01-02' });
    expect(shape(act)).toEqual(['pool-joined']);
    expect(act.events[0]).toMatchObject({
      driveId,
      slotId: slots[0],
      poolId: pool.id,
      poolName: 'tank',
    });
    expect(act.events[0]!.payload).toEqual({ poolRole: 'hot-spare' });
  });

  it('R29: rejects a start date in the future (beyond clock skew)', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!);
    const before = activityCount();
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    expect(thrown(() => joinPool(db(), driveId, { poolId: pool.id, startedAt: future })).code).toBe(
      'invalid',
    );
    expect(activityCount()).toBe(before);
    expect(getDrive(db(), driveId).poolId).toBeNull();
    const nearly = new Date(Date.now() + 60_000).toISOString(); // within tolerance
    expect(joinPool(db(), driveId, { poolId: pool.id, startedAt: nearly }).poolId).toBe(pool.id);
  });

  it('R29: rejects an end date in the future; a past one is the activity date', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!);
    joinPool(db(), driveId, { poolId: pool.id });
    const future = new Date(Date.now() + 60 * 60_000).toISOString();
    expect(thrown(() => leavePool(db(), driveId, { endedAt: future })).code).toBe('invalid');
    expect(eventsOf(driveId, 'pool-left')).toHaveLength(0);
    leavePool(db(), driveId, { endedAt: '2026-02-03T00:00:00.000Z' });
    expect(lastActivity(db())).toMatchObject({ kind: 'pool-left', occurredOn: '2026-02-03' });
  });

  it('role defaults to data and the date to not given', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!);
    const m = joinPool(db(), driveId, { poolId: pool.id });
    expect(m.poolRole).toBe('data');
    expect(lastActivity(db()).occurredOn).toBeNull();
  });

  it('a drive already in a pool is a conflict that points to change', () => {
    const { slots } = setup();
    const a = createPool(db(), { name: 'a' });
    const b = createPool(db(), { name: 'b' });
    const driveId = install('A', slots[0]!, a.id);
    const err = thrown(() => joinPool(db(), driveId, { poolId: b.id }));
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/change/);
    expect(installationOf(driveId)!.poolId).toBe(a.id);
  });

  it('R8/R33: joining while spare is rejected and changes nothing', () => {
    const pool = createPool(db(), { name: 'tank' });
    const d = spare('SP');
    const err = thrown(() => joinPool(db(), d.id, { poolId: pool.id }));
    expect(err.code).toBe('conflict');
    expect(installationOf(d.id)).toBeUndefined();
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
  it('role change on the same pool is a `pool-role-changed` activity with from and to', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    const after = changeMembership(db(), driveId, { role: 'hot-spare' });
    expect(after).toMatchObject({ driveId, poolId: pool.id, poolRole: 'hot-spare' });
    const act = lastActivity(db());
    expect(act.kind).toBe('pool-role-changed');
    expect(act.events).toHaveLength(1);
    expect(act.events[0]).toMatchObject({
      type: 'pool-role-changed',
      driveId,
      slotId: slots[0],
      poolId: pool.id,
    });
    expect(act.events[0]!.payload).toEqual({ from: 'data', to: 'hot-spare' });
  });

  it('same role on the same pool is a no-op with no activity', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    const count = countActivities(db());
    changeMembership(db(), driveId, { poolId: pool.id, role: 'data' });
    expect(countActivities(db())).toBe(count);
  });

  it('pool change is ONE `pool-changed` activity: pool-left on the old pool, pool-joined on the new', () => {
    const { slots } = setup();
    const a = createPool(db(), { name: 'a' });
    const b = createPool(db(), { name: 'b' });
    const driveId = install('A', slots[0]!, a.id);
    const before = countActivities(db());
    const next = changeMembership(db(), driveId, { poolId: b.id });
    expect(next).toMatchObject({ poolId: b.id, poolRole: 'data' });
    expect(countActivities(db())).toBe(before + 1);
    const act = lastActivity(db());
    expect(act.kind).toBe('pool-changed');
    expect(act.events.map((e) => [e.type, e.poolId, e.driveId, e.slotId])).toEqual([
      ['pool-left', a.id, driveId, slots[0]],
      ['pool-joined', b.id, driveId, slots[0]],
    ]);
  });

  it('pool change can also set a new role', () => {
    const { slots } = setup();
    const a = createPool(db(), { name: 'a' });
    const b = createPool(db(), { name: 'b' });
    const driveId = install('A', slots[0]!, a.id);
    const next = changeMembership(db(), driveId, { poolId: b.id, role: 'hot-spare' });
    expect(next.poolRole).toBe('hot-spare');
    expect(lastActivity(db()).events[1]!.payload).toEqual({ poolRole: 'hot-spare' });
  });

  it('change with no pool is a conflict (join first)', () => {
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
    const before = countActivities(db());
    expect(thrown(() => changeMembership(db(), driveId, { poolId: 'nope' })).code).toBe(
      'not-found',
    );
    expect(installationOf(driveId)!.poolId).toBe(pool.id);
    expect(countActivities(db())).toBe(before);
  });
});

describe('leave and history (R29, R33)', () => {
  it('leavePool clears the pool and role, keeps the installation, logs one `pool-left` activity', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    const ended = leavePool(db(), driveId);
    expect(ended).toMatchObject({ driveId, slotId: slots[0], poolId: null, poolRole: null });
    const act = lastActivity(db());
    expect(act.kind).toBe('pool-left');
    expect(act.events[0]).toMatchObject({ type: 'pool-left', poolId: pool.id, poolName: 'tank' });
    expect(act.events[0]!.payload).toEqual({ poolRole: 'data' });
    expect(getDrive(db(), driveId).status).toBe('installed');
  });

  it('leave with no pool is a conflict', () => {
    const { slots } = setup();
    const driveId = install('A', slots[0]!);
    expect(thrown(() => leavePool(db(), driveId)).code).toBe('conflict');
  });

  it('leaving the bay takes the drive out of the pool without a pool event (removed to spares)', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!, pool.id);
    removeToSpares(db(), driveId);
    expect(getDrive(db(), driveId)).toMatchObject({ poolId: null, poolRole: null });
    expect(types(driveId)).not.toContain('pool-left');
    // The uninstall event names the pool the drive left.
    expect(eventsOf(driveId, 'drive-uninstalled')[0]).toMatchObject({ poolId: pool.id });
    expect(getPool(db(), pool.id).members).toEqual([]);
  });

  it('retiring from a bay and RMA both take the drive out of the pool', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const a = install('A', slots[0]!, pool.id);
    const b = install('B', slots[1]!, pool.id);
    retireDrive(db(), a, { reason: 'failed', date: '2026-05-01' });
    sendForRma(db(), b);
    expect(getPool(db(), pool.id).members).toEqual([]);
    expect(installationOf(a)).toBeUndefined();
    expect(installationOf(b)).toBeUndefined();
  });

  it("a pool's history lists the activities with an event on it, each with all its events, newest first", () => {
    const { slots } = setup();
    const a = createPool(db(), { name: 'a' });
    const b = createPool(db(), { name: 'b' });
    const driveId = install('A', slots[0]!, a.id);
    changeMembership(db(), driveId, { poolId: b.id });
    leavePool(db(), driveId);
    const history = listPoolActivities(db(), a.id);
    expect(history.map((h) => h.kind)).toEqual(['pool-changed', 'assigned', 'pool-edited']);
    // The pool-changed activity is returned whole: it also holds the event on the other pool.
    expect(history[0]!.events.map((e) => e.type)).toEqual(['pool-left', 'pool-joined']);
    expect(history.map((h) => h.seq)).toEqual([...history.map((h) => h.seq)].sort((x, y) => y - x));
  });

  it('a failing event write rolls back the pool change', () => {
    const { slots } = setup();
    const pool = createPool(db(), { name: 'tank' });
    const driveId = install('A', slots[0]!);
    opened.sqlite.exec(`
      CREATE TRIGGER fail_pool_joined BEFORE INSERT ON events
      WHEN NEW.type = 'pool-joined'
      BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `);
    expect(() => joinPool(db(), driveId, { poolId: pool.id })).toThrow(/boom/);
    expect(installationOf(driveId)!.poolId).toBeNull();
  });
});
