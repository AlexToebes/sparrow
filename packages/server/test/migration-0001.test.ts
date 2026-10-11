import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/client.js';

// R60: migration 0001 makes the retirement date optional by rebuilding `drives` safely
// (copy, drop, recreate, refill) so existing data, FKs and indexes survive.

const FULL = fileURLToPath(new URL('../drizzle', import.meta.url));
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sparrow-mig-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A migrations folder holding only 0000, to build a database as the previous release left it. */
function baselineFolder(): string {
  const folder = path.join(dir, 'only-0000');
  mkdirSync(path.join(folder, 'meta'), { recursive: true });
  const journal = JSON.parse(readFileSync(path.join(FULL, 'meta/_journal.json'), 'utf8')) as {
    entries: { tag: string }[];
  };
  const first = journal.entries[0]!;
  writeFileSync(
    path.join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: [first] }),
  );
  cpSync(path.join(FULL, `${first.tag}.sql`), path.join(folder, `${first.tag}.sql`));
  return folder;
}

const T = '2026-01-01T00:00:00.000Z';
function seed(sqlite: Database.Database) {
  const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
  run(
    'INSERT INTO enclosures (id, name, created_at, updated_at) VALUES (?,?,?,?)',
    'e1',
    'NAS',
    T,
    T,
  );
  run(
    'INSERT INTO grids (id, enclosure_id, name, rows, columns, orientation, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?)',
    'g1',
    'e1',
    'Front',
    1,
    2,
    'landscape',
    T,
    T,
  );
  run(
    'INSERT INTO slots (id, grid_id, position, label, created_at, updated_at) VALUES (?,?,?,?,?,?)',
    's1',
    'g1',
    0,
    'Bay 1',
    T,
    T,
  );
  run(
    'INSERT INTO pools (id, name, layout_label, created_at, updated_at) VALUES (?,?,?,?,?)',
    'p1',
    'tank',
    null,
    T,
    T,
  );
  const drive = `INSERT INTO drives (id, serial, serial_normalized, wwn, model, capacity_bytes, drive_type, status, slot_id,
    retirement_reason, retirement_date, replaced_by_drive_id, retirement_note, installed_on, notes, created_at, updated_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`;
  run(
    drive,
    'd-inst',
    'SN1',
    'SN1',
    'wwn1',
    'Model A',
    4_000_000_000_000,
    'HDD',
    'installed',
    's1',
    null,
    null,
    null,
    null,
    '2025-05-05',
    'hello',
    T,
    T,
  );
  run(
    drive,
    'd-spare',
    'SN2',
    'SN2',
    null,
    null,
    null,
    null,
    'spare',
    null,
    null,
    null,
    null,
    null,
    null,
    null,
    T,
    T,
  );
  run(
    drive,
    'd-ret',
    'SN3',
    'SN3',
    null,
    'Model C',
    2_000_000_000_000,
    'SSD',
    'retired',
    null,
    'replaced',
    '2026-03-03',
    'd-inst',
    'old',
    null,
    null,
    T,
    T,
  );
  run(
    'INSERT INTO memberships (id, drive_id, pool_id, role, source, started_at, ended_at, created_at) VALUES (?,?,?,?,?,?,?,?)',
    'm1',
    'd-inst',
    'p1',
    'data',
    'manual',
    T,
    null,
    T,
  );
  run(
    'INSERT INTO events (id, drive_id, type, at, payload) VALUES (?,?,?,?,?)',
    'ev1',
    'd-inst',
    'drive-installed',
    T,
    '{"a":1}',
  );
  run(
    'INSERT INTO events (id, drive_id, type, at, payload) VALUES (?,?,?,?,?)',
    'ev2',
    'd-ret',
    'drive-retired',
    T,
    '{"date":"2026-03-03"}',
  );
}

const dump = (sqlite: Database.Database) => ({
  drives: sqlite.prepare('SELECT * FROM drives ORDER BY id').all(),
  memberships: sqlite.prepare('SELECT * FROM memberships ORDER BY id').all(),
  events: sqlite.prepare('SELECT * FROM events ORDER BY id').all(),
  slots: sqlite.prepare('SELECT * FROM slots ORDER BY id').all(),
});

describe('migration 0001: optional retirement date (R60)', () => {
  it('R60: keeps every row, FK and index of an existing 0000 database with foreign keys on', () => {
    const file = path.join(dir, 'app.db');
    const old = new Database(file);
    old.pragma('foreign_keys = ON');
    migrate(drizzle(old), { migrationsFolder: baselineFolder() });
    seed(old);
    const before = dump(old);
    expect(before.drives).toHaveLength(3);
    old.close();

    const { sqlite } = openDatabase(file);
    try {
      expect(dump(sqlite)).toEqual(before);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(sqlite.pragma('foreign_keys', { simple: true })).toBe(1);
      const indexes = sqlite
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'drives'")
        .all()
        .map((r) => (r as { name: string }).name);
      expect(indexes).toEqual(
        expect.arrayContaining(['drives_serial_normalized_unique', 'drives_slot_id_unique']),
      );
      // The two migrations are recorded, and the old retired-needs-date constraint is gone.
      expect(
        (sqlite.prepare('SELECT count(*) AS c FROM __drizzle_migrations').get() as { c: number }).c,
      ).toBe(2);

      const ins = (id: string, extra: Record<string, unknown>) => {
        const row = {
          id,
          serial: id,
          serial_normalized: id,
          status: 'spare',
          created_at: T,
          updated_at: T,
          ...extra,
        };
        const keys = Object.keys(row);
        sqlite
          .prepare(
            `INSERT INTO drives (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
          )
          .run(...Object.values(row));
      };
      // A retired drive without a date is now fine; the reason is still required.
      ins('r-nodate', { status: 'retired', retirement_reason: 'failed', retirement_date: null });
      expect(() => ins('r-noreason', { status: 'retired', retirement_date: '2026-01-01' })).toThrow(
        /CHECK/,
      );
      // The other CHECKs, the self-FK, the unique indexes and the real FKs are still enforced.
      expect(() =>
        ins('x1', { status: 'installed', slot_id: null, installed_on: '2026-01-01' }),
      ).toThrow(/CHECK/);
      expect(() => ins('x2', { status: 'spare', installed_on: '2026-01-01' })).toThrow(/CHECK/);
      expect(() => ins('x3', { status: 'spare', slot_id: 's1' })).toThrow(/CHECK/);
      expect(() => ins('x4', { replaced_by_drive_id: 'x4' })).toThrow(/CHECK/);
      expect(() => ins('x5', { status: 'bogus' })).toThrow(/CHECK/);
      expect(() => ins('x6', { drive_type: 'tape' })).toThrow(/CHECK/);
      expect(() => ins('x7', { condition: 'bad' })).toThrow(/CHECK/);
      expect(() => ins('x8', { status: 'retired', retirement_reason: 'nope' })).toThrow(/CHECK/);
      expect(() => ins('x9', { replaced_by_drive_id: 'missing' })).toThrow(/FOREIGN KEY/);
      expect(() => ins('x10', { serial_normalized: 'SN2' })).toThrow(/UNIQUE/);
      expect(() => ins('x11', { status: 'installed', slot_id: 's1' })).toThrow(/UNIQUE/);
      // Referenced drives still cannot be removed (FKs from events and memberships are live).
      expect(() => sqlite.prepare("DELETE FROM drives WHERE id = 'd-inst'").run()).toThrow(
        /FOREIGN KEY/,
      );
    } finally {
      sqlite.close();
    }
  });

  it('R60: migrates a fresh empty database and accepts a retired drive without a date', () => {
    const { sqlite } = openDatabase(':memory:');
    try {
      sqlite
        .prepare(
          "INSERT INTO drives (id, serial, serial_normalized, status, retirement_reason, created_at, updated_at) VALUES ('a','A','A','retired','other',?,?)",
        )
        .run(T, T);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    } finally {
      sqlite.close();
    }
  });
});
