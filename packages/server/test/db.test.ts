import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/api/app.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { recordActivity } from '../src/core/activities.js';
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

const spare = (serial: string) => repo.drives.create({ serial });

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

  it('R29: creates an installation holding the pool and role', () => {
    const { slots } = seedSlots(1);
    const d = spare('M1');
    const p = repo.pools.create({ name: 'tank', layoutLabel: null });
    const i = repo.installations.create({
      driveId: d.id,
      slotId: slots[0]!.id,
      poolId: p.id,
      poolRole: 'data',
      installedOn: '2026-01-01',
    });
    expect(repo.installations.get(d.id)).toEqual(i);
    expect(repo.installations.list()).toHaveLength(1);
  });

  it('R14: records an activity with ordered events and a JSON payload', () => {
    const d = spare('E1');
    const stored = opened.db.transaction((tx) =>
      recordActivity(tx, {
        kind: 'drive-added',
        events: [
          { type: 'drive-created', driveId: d.id, payload: { a: 1 } },
          { type: 'drive-updated', driveId: d.id, payload: { changes: {} } },
        ],
      }),
    );
    expect(stored.seq).toBe(1);
    expect(stored.events.map((e) => [e.ord, e.type, e.driveId])).toEqual([
      [0, 'drive-created', d.id],
      [1, 'drive-updated', d.id],
    ]);
    expect(stored.events[0]!.payload).toEqual({ a: 1 });
    expect(() =>
      opened.db.transaction((tx) =>
        recordActivity(tx, {
          kind: 'drive-added',
          events: [{ type: 'bogus' as never, driveId: d.id, payload: {} }],
        }),
      ),
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

  it('D7: a bay holds at most one drive and a drive sits in at most one bay', () => {
    const { slots } = seedSlots(2);
    const a = spare('A');
    const b = spare('B');
    repo.installations.create({ driveId: a.id, slotId: slots[0]!.id });
    expect(() => repo.installations.create({ driveId: b.id, slotId: slots[0]!.id })).toThrow(
      /UNIQUE/,
    );
    expect(() => repo.installations.create({ driveId: a.id, slotId: slots[1]!.id })).toThrow(
      /UNIQUE/,
    );
  });

  it('R29: pool and pool role are set together, and the role is a known one', () => {
    const { slots } = seedSlots(2);
    const p = repo.pools.create({ name: 'tank', layoutLabel: null });
    const a = spare('A');
    const b = spare('B');
    expect(() =>
      repo.installations.create({ driveId: a.id, slotId: slots[0]!.id, poolId: p.id }),
    ).toThrow(/CHECK/);
    expect(() =>
      repo.installations.create({ driveId: a.id, slotId: slots[0]!.id, poolRole: 'data' }),
    ).toThrow(/CHECK/);
    expect(() =>
      repo.installations.create({
        driveId: b.id,
        slotId: slots[1]!.id,
        poolId: p.id,
        poolRole: 'cache' as never,
      }),
    ).toThrow(/CHECK/);
  });

  it('D7: the installation needs a real drive and a real bay', () => {
    const { slots } = seedSlots(1);
    expect(() => repo.installations.create({ driveId: 'nope', slotId: slots[0]!.id })).toThrow(
      /FOREIGN KEY/,
    );
    expect(() => repo.installations.create({ driveId: spare('A').id, slotId: 'nope' })).toThrow(
      /FOREIGN KEY/,
    );
  });

  it('D7: a retired drive cannot be installed (trigger in the baseline SQL)', () => {
    const { slots } = seedSlots(1);
    const d = repo.drives.create({ serial: 'R', retirementReason: 'failed' });
    expect(() => repo.installations.create({ driveId: d.id, slotId: slots[0]!.id })).toThrow(
      /retired drive cannot be installed/,
    );
  });

  it('R13, R60: the retirement date and note need a reason; the date may be null (not recorded)', () => {
    expect(() => repo.drives.create({ serial: 'B', retirementDate: '2026-01-02' })).toThrow(
      /CHECK/,
    );
    expect(() => repo.drives.create({ serial: 'B1', retirementNote: 'x' })).toThrow(/CHECK/);
    expect(
      repo.drives.create({ serial: 'B2', retirementReason: 'failed' }).retirementDate,
    ).toBeNull();
    const ok = repo.drives.create({
      serial: 'C',
      retirementReason: 'failed',
      retirementDate: '2026-01-02',
    });
    expect(ok.retirementReason).toBe('failed');
  });

  it('R13: the drive row has no status, bay or installation date (they are computed)', () => {
    const columns = (
      opened.sqlite.prepare("SELECT name FROM pragma_table_info('drives')").all() as {
        name: string;
      }[]
    ).map((c) => c.name);
    for (const gone of ['status', 'slot_id', 'installed_on']) expect(columns).not.toContain(gone);
  });

  it('R14: activities have a unique monotonic seq, and events are ordered within an activity', () => {
    const d = spare('S1');
    const write = () =>
      opened.db.transaction((tx) =>
        recordActivity(tx, {
          kind: 'drive-added',
          events: [{ type: 'drive-created', driveId: d.id, payload: {} }],
        }),
      );
    expect([write().seq, write().seq, write().seq]).toEqual([1, 2, 3]);
    expect(() =>
      opened.sqlite.exec(
        "INSERT INTO activities (id, seq, kind, recorded_at) VALUES ('dup', 2, 'drive-added', 't')",
      ),
    ).toThrow(/UNIQUE/);
    expect(() =>
      opened.sqlite.exec(
        "INSERT INTO activities (id, seq, kind, recorded_at) VALUES ('bad', 9, 'exploded', 't')",
      ),
    ).toThrow(/CHECK/);
  });

  it('D5: drives expose no delete function', () => {
    expect(Object.keys(repo.drives).sort()).toEqual(['create', 'get', 'list']);
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
          'installations',
          'activities',
          'events',
          'app_meta',
          'provider_snapshot',
        ]),
      );
      createRepositories(first.db).drives.create({ serial: 'KEEP' });
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
  it('R60: a fresh DB accepts a retired drive without a date, and refuses a date without a reason', () => {
    const { sqlite } = openDatabase(':memory:');
    try {
      const ins = (id: string, reason: string | null, date: string | null) =>
        sqlite
          .prepare(
            'INSERT INTO drives (id, serial, serial_normalized, retirement_reason, retirement_date, created_at, updated_at) VALUES (?,?,?,?,?,?,?)',
          )
          .run(id, id, id, reason, date, 't', 't');
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
    const a = opened.db.transaction((tx) =>
      recordActivity(tx, {
        kind: 'health-polled',
        events: [{ type: 'health-changed', driveId: d.id, payload: { to: 'ok' } }],
      }),
    );
    expect(a.events[0]!.type).toBe('health-changed');
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
