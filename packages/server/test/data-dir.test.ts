import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkDataDirectory, DataDirectoryError } from '../src/db/client.js';

// Root bypasses file permissions, so the read-only cases only mean something for other users.
const isRoot = process.getuid?.() === 0;

function captureError(fn: () => void): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  return undefined;
}

describe('R16: data directory check', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'sparrow-data-'));
  });

  afterEach(() => {
    // Restore permissions so the temp tree can be removed.
    chmodSync(dir, 0o700);
    rmSync(dir, { recursive: true, force: true });
  });

  it('R16: accepts a writable directory with no database yet', () => {
    expect(() => checkDataDirectory(dir, path.join(dir, 'app.db'))).not.toThrow();
  });

  it.skipIf(isRoot)(
    'R16: names the path, the uid and chown when the directory is read-only',
    () => {
      chmodSync(dir, 0o500);
      const err = captureError(() => checkDataDirectory(dir, path.join(dir, 'app.db')));
      expect(err).toBeInstanceOf(DataDirectoryError);
      const message = (err as DataDirectoryError).message;
      expect(message).toContain(dir);
      expect(message).toContain('chown');
      expect(message).toContain(`uid ${process.getuid?.()}`);
      expect(message).toContain('EACCES');
    },
  );

  it.skipIf(isRoot)('R16: rejects an existing database file that is read-only', () => {
    const dbFile = path.join(dir, 'app.db');
    writeFileSync(dbFile, '');
    chmodSync(dbFile, 0o400);
    const err = captureError(() => checkDataDirectory(dir, dbFile));
    expect(err).toBeInstanceOf(DataDirectoryError);
    expect((err as DataDirectoryError).message).toContain(dbFile);
    expect((err as DataDirectoryError).message).toContain('chown');
  });
});
