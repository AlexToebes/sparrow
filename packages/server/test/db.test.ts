import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';

let opened: OpenedDatabase;
let repo: Repositories;

beforeEach(() => {
  opened = openDatabase(':memory:');
  repo = createRepositories(opened.db);
});
afterEach(() => opened.sqlite.close());

function seedSlots(n = 2) {
  const enclosure = repo.enclosures.create({ name: 'NAS' });
  const grid = repo.grids.create({
    enclosureId: enclosure.id,
    name: 'Front',
    rows: 1,
    columns: n,
    orientation: 'landscape',
  });
  const slotList = Array.from({ length: n }, (_, i) =>
    repo.slots.create({ gridId: grid.id, position: i, label: null }),
  );
  return { enclosure, grid, slots: slotList };
}

const spare = (serial: string) => repo.drives.create({ serial, status: 'spare' });

describe('record creation (R11, R29, R30, R39, R14)', () => {
  it('R39: creates enclosure, grid and slots with generated ids and UTC timestamps', () => {
    const { enclosure, grid, slots } = seedSlots(2);
    expect(enclosure.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(enclosure.createdAt).toMatch(/^\d{4}-\d\d-\d\dT.*Z$/);
    expect(repo.grids.get(grid.id)?.orientation).toBe('landscape');
    expect(repo.slots.listByGrid(grid.id).map((s) => s.id)).toEqual(slots.map((s) => s.id));
    expect(repo.enclosures.list()).toHaveLength(1);
    expect(repo.grids.list()).toHaveLength(1);
  });

  it('R11/D6: creates a drive with trimmed serial and normalized serial', () => {
    const d = spare('  ab-12 ');
    expect(d.serial).toBe('ab-12');
    expect(d.serialNormalized).toBe('AB-12');
    expect(d.model).toBeNull();
    expect(repo.drives.get(d.id)).toEqual(d);
    expect(repo.drives.list()).toHaveLength(1);
  });

  it('R30: creates a pool; duplicate names rejected', () => {
    const p = repo.pools.create({ name: 'tank', layoutLabel: 'raidz2' });
    expect(repo.pools.get(p.id)?.layoutLabel).toBe('raidz2');
    expect(() => repo.pools.create({ name: 'tank', layoutLabel: null })).toThrow(/UNIQUE/);
    expect(() => repo.pools.create({ name: '', layoutLabel: null })).toThrow(/CHECK/);
  });

  it('R29: creates a membership', () => {
    const d = spare('M1');
    const p = repo.pools.create({ name: 'tank', layoutLabel: null });
    const m = repo.memberships.create({
      driveId: d.id,
      poolId: p.id,
      role: 'data',
      source: 'manual',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
    });
    expect(repo.memberships.get(m.id)).toEqual(m);
    expect(repo.memberships.listByDrive(d.id)).toHaveLength(1);
  });

  it('R14: creates an event with a JSON payload', () => {
    const d = spare('E1');
    const e = repo.events.create({ driveId: d.id, type: 'drive-created', payload: { a: 1 } });
    expect(repo.events.get(e.id)?.payload).toEqual({ a: 1 });
    expect(repo.events.listByDrive(d.id)).toHaveLength(1);
    expect(() =>
      repo.events.create({ driveId: d.id, type: 'bogus' as never, payload: {} }),
    ).toThrow(/CHECK/);
  });

  it('R39: grid name unique within an enclosure; grid dims must be >= 1', () => {
    const { enclosure } = seedSlots(1);
    const dup = { enclosureId: enclosure.id, name: 'Front', rows: 1, columns: 1 };
    expect(() => repo.grids.create({ ...dup, orientation: 'portrait' })).toThrow(/UNIQUE/);
    expect(() =>
      repo.grids.create({ ...dup, name: 'x', rows: 0, orientation: 'portrait' }),
    ).toThrow(/CHECK/);
  });
});

describe('constraints', () => {
  it('D6: rejects a duplicate serial after normalization', () => {
    spare('ABC');
    expect(() => spare(' abc ')).toThrow(/UNIQUE/);
  });

  it('D7: rejects two drives in the same slot', () => {
    const { slots } = seedSlots(1);
    const slotId = slots[0]!.id;
    repo.drives.create({ serial: 'A', status: 'installed', slotId });
    expect(() => repo.drives.create({ serial: 'B', status: 'installed', slotId })).toThrow(
      /UNIQUE/,
    );
  });

  it('D7/R11: installed requires a slot; a slot requires installed status', () => {
    const { slots } = seedSlots(1);
    expect(() => repo.drives.create({ serial: 'A', status: 'installed' })).toThrow(/CHECK/);
    expect(() =>
      repo.drives.create({ serial: 'B', status: 'spare', slotId: slots[0]!.id }),
    ).toThrow(/CHECK/);
  });

  it('R13, R60: retired requires a reason; the date may be null (not recorded)', () => {
    expect(() => repo.drives.create({ serial: 'A', status: 'retired' })).toThrow(/CHECK/);
    expect(() =>
      repo.drives.create({ serial: 'B', status: 'retired', retirementDate: '2026-01-02' }),
    ).toThrow(/CHECK/);
    expect(
      repo.drives.create({ serial: 'B2', status: 'retired', retirementReason: 'failed' })
        .retirementDate,
    ).toBeNull();
    const ok = repo.drives.create({
      serial: 'C',
      status: 'retired',
      retirementReason: 'failed',
      retirementDate: '2026-01-02',
    });
    expect(ok.status).toBe('retired');
  });

  it('D5: drives expose no delete function', () => {
    expect(Object.keys(repo.drives).sort()).toEqual(['create', 'get', 'list']);
  });

  it('R29: second open membership for a drive is rejected; closed + open is fine', () => {
    const d = spare('M1');
    const p = repo.pools.create({ name: 'tank', layoutLabel: null });
    const base = { driveId: d.id, poolId: p.id, role: 'data', source: 'manual' } as const;
    repo.memberships.create({
      ...base,
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: '2026-02-01T00:00:00.000Z',
    });
    repo.memberships.create({ ...base, startedAt: '2026-02-01T00:00:00.000Z', endedAt: null });
    expect(() =>
      repo.memberships.create({ ...base, startedAt: '2026-03-01T00:00:00.000Z', endedAt: null }),
    ).toThrow(/UNIQUE/);
    expect(repo.memberships.listByDrive(d.id)).toHaveLength(2);
  });

  it('R29: membership cannot end before it starts', () => {
    const d = spare('M1');
    const p = repo.pools.create({ name: 'tank', layoutLabel: null });
    expect(() =>
      repo.memberships.create({
        driveId: d.id,
        poolId: p.id,
        role: 'data',
        source: 'manual',
        startedAt: '2026-02-01T00:00:00.000Z',
        endedAt: '2026-01-01T00:00:00.000Z',
      }),
    ).toThrow(/CHECK/);
  });

  it('R39: foreign keys are enforced (slot with unknown grid rejected)', () => {
    expect(opened.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
    expect(() => repo.slots.create({ gridId: 'missing', position: 0, label: null })).toThrow(
      /FOREIGN KEY/,
    );
  });

  it('R39: restrict delete of a grid that has slots', () => {
    const { grid } = seedSlots(1);
    expect(() => opened.sqlite.prepare('DELETE FROM grids WHERE id = ?').run(grid.id)).toThrow(
      /FOREIGN KEY/,
    );
  });
});

describe('migrations (R16)', () => {
  it('migrates a fresh DB file, sets pragmas, and re-opening keeps data and adds no migration', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'sparrow-'));
    try {
      const file = path.join(dir, 'app.db');
      const first = openDatabase(file);
      expect(first.sqlite.pragma('journal_mode', { simple: true })).toBe('wal');
      expect(first.sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      const tables = first.sqlite
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE '%drizzle%'",
        )
        .all()
        .map((r) => (r as { name: string }).name);
      expect(tables).toEqual(
        expect.arrayContaining([
          'enclosures',
          'grids',
          'slots',
          'drives',
          'pools',
          'memberships',
          'events',
          'app_meta',
          'provider_snapshot',
        ]),
      );
      createRepositories(first.db).drives.create({ serial: 'KEEP', status: 'spare' });
      const count = () =>
        (
          first.sqlite.prepare('SELECT count(*) AS c FROM __drizzle_migrations').get() as {
            c: number;
          }
        ).c;
      const applied = count();
      expect(applied).toBeGreaterThan(0);
      first.sqlite.close();

      const second = openDatabase(file);
      expect(
        (
          second.sqlite.prepare('SELECT count(*) AS c FROM __drizzle_migrations').get() as {
            c: number;
          }
        ).c,
      ).toBe(applied);
      expect(
        createRepositories(second.db)
          .drives.list()
          .map((d) => d.serialNormalized),
      ).toEqual(['KEEP']);
      second.sqlite.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('API (R67)', () => {
  it('R67: GET /api/health returns 200 {status: ok} without any provider', async () => {
    const app = buildApp({ db: opened.db });
    const res = await app.inject({ method: 'GET', url: '/api/health' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });
    await app.close();
  });
});

describe('optional retirement date in the baseline (R60)', () => {
  it('R60: a fresh DB accepts a retired drive without a date, and still requires the reason', () => {
    const { sqlite } = openDatabase(':memory:');
    try {
      const ins = (id: string, reason: string | null, date: string | null) =>
        sqlite
          .prepare(
            "INSERT INTO drives (id, serial, serial_normalized, status, retirement_reason, retirement_date, created_at, updated_at) VALUES (?,?,?,'retired',?,?,'t','t')",
          )
          .run(id, id, id, reason, date);
      ins('a', 'failed', null);
      expect(() => ins('b', null, '2026-01-01')).toThrow(/CHECK/);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});

describe('foundation for the next batch (R20, R34, R72)', () => {
  it('R20: a fresh DB accepts an event of type health-changed', () => {
    const d = spare('H1');
    const e = repo.events.create({ driveId: d.id, type: 'health-changed', payload: { to: 'ok' } });
    expect(repo.events.get(e.id)?.type).toBe('health-changed');
  });

  it('R72: a fresh DB accepts a pool with expected_members 6 and round-trips it', () => {
    const p = repo.pools.create({ name: 'tank', layoutLabel: null, expectedMembers: 6 });
    expect(repo.pools.get(p.id)?.expectedMembers).toBe(6);
    expect(repo.pools.create({ name: 'spares', layoutLabel: null }).expectedMembers).toBeNull();
  });

  it('R72: a pool with expected_members 0 is rejected by the CHECK constraint', () => {
    expect(() =>
      repo.pools.create({ name: 'empty', layoutLabel: null, expectedMembers: 0 }),
    ).toThrow(/CHECK/);
  });
});
