import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const FULL = fileURLToPath(new URL('../drizzle', import.meta.url));

let tmp: string;
let sqlite: Database.Database;
beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sparrow-mig-'));
});
afterEach(() => {
  sqlite?.close();
  rmSync(tmp, { recursive: true, force: true });
});

/** A migrations folder that stops before 0003 (the previous release's schema). */
function previousMigrations(): string {
  const dir = path.join(tmp, 'before');
  cpSync(FULL, dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
    entries: { tag: string }[];
  };
  journal.entries = journal.entries.filter((e) => !e.tag.startsWith('0003'));
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

describe('R68: migration 0003 adds drives.installed_on', () => {
  it('backfills installed drives from their latest drive-installed event, else updated_at', () => {
    sqlite = new Database(path.join(tmp, 'app.db'));
    sqlite.pragma('foreign_keys = ON'); // as in production
    migrate(drizzle(sqlite), { migrationsFolder: previousMigrations() });

    const t = '2026-01-01T00:00:00.000Z';
    sqlite.exec(`
      INSERT INTO enclosures (id, name, created_at, updated_at) VALUES ('e1', 'NAS', '${t}', '${t}');
      INSERT INTO grids (id, enclosure_id, name, rows, columns, orientation, created_at, updated_at)
        VALUES ('g1', 'e1', 'Front', 1, 4, 'landscape', '${t}', '${t}');
      INSERT INTO slots (id, grid_id, position, created_at, updated_at) VALUES
        ('s1', 'g1', 0, '${t}', '${t}'), ('s2', 'g1', 1, '${t}', '${t}'), ('s3', 'g1', 2, '${t}', '${t}');
      INSERT INTO pools (id, name, created_at, updated_at) VALUES ('p1', 'big', '${t}', '${t}');
    `);
    const insertDrive = (id: string, status: string, slot: string | null, updated: string) =>
      sqlite
        .prepare(
          `INSERT INTO drives (id, serial, serial_normalized, status, slot_id, retirement_reason, retirement_date, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          id,
          id.toUpperCase(),
          status,
          slot,
          status === 'retired' ? 'failed' : null,
          status === 'retired' ? '2026-02-02' : null,
          t,
          updated,
        );
    insertDrive('twice', 'installed', 's1', '2026-08-30T10:00:00.000Z');
    insertDrive('noevent', 'installed', 's2', '2026-07-07T23:59:59.000Z');
    insertDrive('shelf', 'spare', null, t);
    insertDrive('gone', 'retired', null, t);
    const event = (id: string, drive: string, type: string, at: string) =>
      sqlite
        .prepare(`INSERT INTO events (id, drive_id, type, at, payload) VALUES (?, ?, ?, ?, '{}')`)
        .run(id, drive, type, at);
    event('ev1', 'twice', 'drive-installed', '2026-03-03T12:00:00.000Z');
    event('ev2', 'twice', 'drive-removed', '2026-04-04T12:00:00.000Z');
    event('ev3', 'twice', 'drive-installed', '2026-05-05T08:00:00.000Z');
    event('ev4', 'twice', 'drive-updated', '2026-08-30T10:00:00.000Z');
    event('ev5', 'gone', 'drive-installed', '2026-01-10T00:00:00.000Z');
    sqlite
      .prepare(
        `INSERT INTO memberships (id, drive_id, pool_id, role, source, started_at, created_at)
         VALUES ('m1', 'twice', 'p1', 'data', 'manual', '2026-05-05T08:00:00.000Z', '${t}')`,
      )
      .run();

    migrate(drizzle(sqlite), { migrationsFolder: FULL });

    const on = (id: string) =>
      (
        sqlite
          .prepare('SELECT installed_on AS v, slot_id AS s FROM drives WHERE id = ?')
          .get(id) as {
          v: string | null;
          s: string | null;
        }
      ).v;
    expect(on('twice')).toBe('2026-05-05');
    expect(on('noevent')).toBe('2026-07-07');
    expect(on('shelf')).toBeNull();
    expect(on('gone')).toBeNull();

    // Children and indexes survive the table rebuild, and foreign keys still hold.
    expect(sqlite.prepare('SELECT count(*) AS n FROM events').get()).toEqual({ n: 5 });
    expect(sqlite.prepare('SELECT count(*) AS n FROM memberships').get()).toEqual({ n: 1 });
    expect(sqlite.pragma('foreign_key_check')).toEqual([]);
    expect(
      sqlite
        .prepare(`SELECT count(*) AS n FROM sqlite_master WHERE name = 'drives_slot_id_unique'`)
        .get(),
    ).toEqual({ n: 1 });

    // The new CHECKs are live.
    expect(() =>
      sqlite.prepare(`UPDATE drives SET installed_on = NULL WHERE id = 'twice'`).run(),
    ).toThrow(/CHECK/);
    expect(() =>
      sqlite.prepare(`UPDATE drives SET installed_on = '2026-01-01' WHERE id = 'shelf'`).run(),
    ).toThrow(/CHECK/);
  });
});
