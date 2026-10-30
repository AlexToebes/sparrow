import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { missingSchemaParts, openDatabase } from '../src/db/client.js';

// R78 (AGENTS.md section 6): the database is in production, so migration 0001 is tested the way it
// runs for an owner: a database created at migration 0000 with real-looking data in it is opened by
// the current code. Migration 0001 adds drive_conflicts and rebuilds activities and events (their CHECK
// lists gained the conflict kinds); no row may be lost, least of all the events, which cascade from
// their activity.

const DRIZZLE = path.resolve(import.meta.dirname, '../drizzle');
let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), 'sparrow-migration-'));
  file = path.join(dir, 'app.db');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A copy of the migrations folder that stops after migration 0000: the database as 1.0.0 shipped it. */
function baselineOnly(): string {
  const folder = path.join(dir, 'drizzle-0000');
  cpSync(DRIZZLE, folder, { recursive: true });
  const journalPath = path.join(folder, 'meta/_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { idx: number }[] };
  journal.entries = journal.entries.filter((e) => e.idx === 0);
  writeFileSync(journalPath, JSON.stringify(journal));
  return folder;
}

const T = '2026-03-04T05:06:07.000Z';

/** A small but real-looking 1.0.0 database: layout, pool, drives, installations and a log with events. */
function seed(sqlite: Database.Database): void {
  const run = (sql: string, ...args: unknown[]) => sqlite.prepare(sql).run(...args);
  run('INSERT INTO enclosures VALUES (?, ?, ?, ?)', 'enc1', 'NAS', T, T);
  run(
    'INSERT INTO grids VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    'g1',
    'enc1',
    'Front',
    1,
    3,
    'landscape',
    T,
    T,
  );
  for (const [i, id] of ['s1', 's2', 's3'].entries()) {
    run('INSERT INTO slots VALUES (?, ?, ?, ?, ?, ?)', id, 'g1', i, i === 0 ? 'Bay A' : null, T, T);
  }
  run('INSERT INTO pools VALUES (?, ?, ?, ?, ?, ?)', 'p1', 'tank', 'raidz1', 3, T, T);
  const drive = (id: string, serial: string, retired = false) =>
    run(
      `INSERT INTO drives (id, serial, serial_normalized, model, capacity_bytes, drive_type,
         retirement_reason, retirement_date, created_at, updated_at)
       VALUES (?, ?, ?, 'ST4000', 4000000000000, 'HDD', ?, ?, ?, ?)`,
      id,
      serial,
      serial.toUpperCase(),
      retired ? 'failed' : null,
      retired ? '2026-02-02' : null,
      T,
      T,
    );
  drive('d1', 'wd-aaa');
  drive('d2', 'wd-bbb');
  drive('d3', 'wd-ccc');
  drive('d4', 'wd-old', true);
  run('INSERT INTO installations VALUES (?, ?, ?, ?, ?)', 'd1', 's1', 'p1', 'data', '2025-01-01');
  run('INSERT INTO installations VALUES (?, ?, ?, ?, ?)', 'd2', 's2', 'p1', 'data', null);

  const activity = (id: string, seq: number, kind: string, occurredOn: string | null) =>
    run('INSERT INTO activities VALUES (?, ?, ?, ?, ?, ?)', id, seq, kind, T, occurredOn, null);
  const event = (
    id: string,
    activityId: string,
    ord: number,
    type: string,
    driveId: string | null,
    payload: object,
  ) =>
    run(
      `INSERT INTO events (id, activity_id, ord, type, drive_id, slot_id, slot_label, grid_id, grid_name,
         pool_id, pool_name, payload) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      activityId,
      ord,
      type,
      driveId,
      driveId === 'd1' ? 's1' : null,
      driveId === 'd1' ? 'Bay A' : null,
      driveId === 'd1' ? 'g1' : null,
      driveId === 'd1' ? 'Front' : null,
      driveId === 'd1' ? 'p1' : null,
      driveId === 'd1' ? 'tank' : null,
      JSON.stringify(payload),
    );
  activity('a1', 1, 'drive-added', null);
  event('e1', 'a1', 0, 'drive-created', 'd1', { id: 'd1', serial: 'wd-aaa' });
  activity('a2', 2, 'assigned', '2025-01-01');
  event('e2', 'a2', 0, 'drive-installed', 'd1', { poolRole: 'data' });
  event('e3', 'a2', 1, 'pool-joined', 'd1', { poolRole: 'data' });
  activity('a3', 3, 'layout-updated', null);
  event('e4', 'a3', 0, 'slot-relabeled', null, { from: null, to: 'Bay A' });
  activity('a4', 4, 'retired', '2026-02-02');
  event('e5', 'a4', 0, 'drive-retired', 'd4', { reason: 'failed', note: 'clicks "loudly"' });
}

const TABLES = [
  'enclosures',
  'grids',
  'slots',
  'pools',
  'drives',
  'installations',
  'activities',
  'events',
  'app_meta',
] as const;

const dump = (sqlite: Database.Database) =>
  Object.fromEntries(
    TABLES.map((t) => [t, sqlite.prepare(`SELECT * FROM ${t} ORDER BY 1, 2`).all()]),
  );

describe('R78: migration 0001 (drive_conflicts) on a database created at migration 0000', () => {
  function migrated() {
    const old = new Database(file);
    old.pragma('journal_mode = WAL');
    old.pragma('foreign_keys = ON');
    migrate(drizzle(old), { migrationsFolder: baselineOnly() });
    seed(old);
    const before = dump(old);
    expect(
      old.prepare("SELECT name FROM sqlite_master WHERE name = 'drive_conflicts'").all(),
    ).toEqual([]);
    old.close();
    // The current code opens it: migrations run, then the schema guard.
    const opened = openDatabase(file);
    return { ...opened, before };
  }

  it('keeps every row of every table, events included (they cascade from their activity)', () => {
    const { sqlite, before } = migrated();
    try {
      expect(before.events).toHaveLength(5);
      expect(dump(sqlite)).toEqual(before);
      expect(sqlite.pragma('foreign_key_check')).toEqual([]);
      expect(missingSchemaParts(sqlite)).toEqual([]);
    } finally {
      sqlite.close();
    }
  });

  it('keeps the indexes, the unique seq, and the cascade from an activity to its events', () => {
    const { sqlite } = migrated();
    try {
      const indexes = (sqlite.pragma('index_list("events")') as { name: string }[]).map(
        (i) => i.name,
      );
      expect(indexes).toEqual(
        expect.arrayContaining([
          'events_drive_idx',
          'events_slot_idx',
          'events_pool_idx',
          'events_activity_ord_idx',
        ]),
      );
      expect(() =>
        sqlite
          .prepare("INSERT INTO activities VALUES ('dup', 4, 'drive-added', ?, NULL, NULL)")
          .run(T),
      ).toThrow(/UNIQUE/);
      sqlite.prepare("DELETE FROM activities WHERE id = 'a2'").run();
      expect(
        sqlite.prepare("SELECT count(*) AS n FROM events WHERE activity_id = 'a2'").get(),
      ).toEqual({ n: 0 });
      expect(sqlite.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 3 });
    } finally {
      sqlite.close();
    }
  });

  it('accepts the new activity kind and event type, and still rejects unknown ones', () => {
    const { sqlite } = migrated();
    try {
      sqlite
        .prepare("INSERT INTO activities VALUES ('a5', 5, 'conflict-added', ?, NULL, NULL)")
        .run(T);
      sqlite
        .prepare(
          `INSERT INTO events (id, activity_id, ord, type, drive_id, payload)
           VALUES ('e6', 'a5', 0, 'conflict-added', 'd1', '{}')`,
        )
        .run();
      expect(() =>
        sqlite.prepare("INSERT INTO activities VALUES ('a6', 6, 'nonsense', ?, NULL, NULL)").run(T),
      ).toThrow(/CHECK/);
      expect(() =>
        sqlite
          .prepare(
            `INSERT INTO events (id, activity_id, ord, type, drive_id, payload)
             VALUES ('e7', 'a5', 1, 'nonsense', NULL, '{}')`,
          )
          .run(),
      ).toThrow(/CHECK/);
    } finally {
      sqlite.close();
    }
  });

  it('the new table stores a pair once in canonical order and refuses the rest', () => {
    const { sqlite } = migrated();
    try {
      const insert = (a: string, b: string, reason: string | null = 'Same batch') =>
        sqlite.prepare('INSERT INTO drive_conflicts VALUES (?, ?, ?, ?)').run(a, b, reason, T);
      insert('d1', 'd2');
      expect(() => insert('d1', 'd2')).toThrow(/UNIQUE|PRIMARY/); // the same pair twice
      expect(() => insert('d2', 'd1')).toThrow(/CHECK/); // wrong order = the same pair reversed
      expect(() => insert('d3', 'd3')).toThrow(/CHECK/); // a drive with itself
      expect(() => insert('d1', 'nope')).toThrow(/FOREIGN KEY/);
      expect(() => insert('d1', 'd3', '')).toThrow(/CHECK/);
      expect(() => insert('d1', 'd3', 'x'.repeat(201))).toThrow(/CHECK/);
      insert('d1', 'd4', null); // a retired drive may be paired; no reason is fine
      // Drives are never deleted (RESTRICT / no cascade).
      expect(() => sqlite.prepare("DELETE FROM drives WHERE id = 'd2'").run()).toThrow(
        /FOREIGN KEY/,
      );
      expect(sqlite.prepare('SELECT count(*) AS n FROM drive_conflicts').get()).toEqual({ n: 2 });
      const indexes = (sqlite.pragma('index_list("drive_conflicts")') as { name: string }[]).map(
        (i) => i.name,
      );
      expect(indexes).toContain('drive_conflicts_drive_b_idx');
    } finally {
      sqlite.close();
    }
  });

  it('a fresh database ends in the same schema as the upgraded one', () => {
    const { sqlite } = migrated();
    const fresh = openDatabase(path.join(dir, 'fresh.db'));
    try {
      const schemaOf = (db: Database.Database) =>
        db
          .prepare(
            "SELECT type, name, tbl_name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '\\_\\_%' ESCAPE '\\' ORDER BY type, name",
          )
          .all();
      expect(schemaOf(sqlite)).toEqual(schemaOf(fresh.sqlite));
      const sqlOf = (db: Database.Database, table: string) =>
        (db.prepare('SELECT sql FROM sqlite_master WHERE name = ?').get(table) as { sql: string })
          .sql;
      for (const t of ['activities', 'events', 'drive_conflicts']) {
        expect(sqlOf(sqlite, t).replace(/\s+/g, ' ')).toBe(
          sqlOf(fresh.sqlite, t).replace(/\s+/g, ' '),
        );
      }
    } finally {
      sqlite.close();
      fresh.sqlite.close();
    }
  });
});
