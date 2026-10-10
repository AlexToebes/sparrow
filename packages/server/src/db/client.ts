import { accessSync, constants, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import * as schema from './schema.js';

export type AppDb = BetterSQLite3Database<typeof schema>;

export interface OpenedDatabase {
  db: AppDb;
  sqlite: Database.Database;
}

const MIGRATIONS_FOLDER = fileURLToPath(new URL('../../drizzle', import.meta.url));

/** A data directory or database file the process cannot use. The message is meant for the operator. */
export class DataDirectoryError extends Error {
  readonly code: string;

  constructor(message: string, code: string) {
    super(message);
    this.name = 'DataDirectoryError';
    this.code = code;
  }
}

function errorCode(err: unknown): string {
  return typeof err === 'object' && err !== null && 'code' in err ? String(err.code) : 'UNKNOWN';
}

function unusableMessage(what: string, target: string, code: string): string {
  const uid = process.getuid?.() ?? 'unknown';
  const gid = process.getgid?.() ?? 'unknown';
  return (
    `Sparrow cannot ${what} "${target}" (running as uid ${uid}, gid ${gid}). ` +
    `Make the mounted directory writable for this user, e.g. "chown -R 1000:1000 <host dir>", ` +
    `or set "user:" in your compose file to the directory's owner. (${code})`
  );
}

/**
 * Checks that the data directory is writable and, if the database already exists, that it is
 * readable and writable. Throws DataDirectoryError with an operator-facing message otherwise.
 */
export function checkDataDirectory(dataDir: string, dbFile: string): void {
  try {
    accessSync(dataDir, constants.W_OK);
  } catch (err) {
    throw new DataDirectoryError(
      unusableMessage('write to its data directory', dataDir, errorCode(err)),
      errorCode(err),
    );
  }
  if (existsSync(dbFile)) {
    try {
      accessSync(dbFile, constants.R_OK | constants.W_OK);
    } catch (err) {
      throw new DataDirectoryError(
        unusableMessage('read and write its database file', dbFile, errorCode(err)),
        errorCode(err),
      );
    }
  }
}

/**
 * Creates the data directory if needed, checks it is usable and opens the database in it.
 * An unusable directory or a SQLITE_CANTOPEN from the driver becomes a DataDirectoryError.
 */
export function openDataDatabase(dataDir: string): OpenedDatabase {
  const dbFile = path.join(dataDir, 'app.db');
  try {
    mkdirSync(dataDir, { recursive: true });
  } catch (err) {
    throw new DataDirectoryError(
      unusableMessage('create its data directory', dataDir, errorCode(err)),
      errorCode(err),
    );
  }
  checkDataDirectory(dataDir, dbFile);
  try {
    return openDatabase(dbFile);
  } catch (err) {
    if (errorCode(err) === 'SQLITE_CANTOPEN') {
      throw new DataDirectoryError(
        unusableMessage('open its database file', dbFile, 'SQLITE_CANTOPEN'),
        'SQLITE_CANTOPEN',
      );
    }
    throw err;
  }
}

/** Opens (creating if needed) the SQLite file, applies pragmas and runs pending migrations. */
export function openDatabase(filePath: string): OpenedDatabase {
  const sqlite = new Database(filePath);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('foreign_keys = ON');
  const db = drizzle(sqlite, { schema });
  migrate(db, { migrationsFolder: MIGRATIONS_FOLDER });
  return { db, sqlite };
}
