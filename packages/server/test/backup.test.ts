import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { exportFileSchema, type ExportFile } from '@sparrow/shared';
import { assignDrive, retireDrive, sendForRma } from '../src/core/assignment.js';
import { exportData, importData } from '../src/core/backup.js';
import { createDrive, updateDrive } from '../src/core/drives.js';
import { DomainError } from '../src/core/errors.js';
import { createLayoutService, seedInitialLayout } from '../src/core/layout.js';
import { createPool } from '../src/core/pools.js';
import { openDatabase, type AppDb, type OpenedDatabase } from '../src/db/client.js';
import { providerSnapshot } from '../src/db/schema.js';

let opened: OpenedDatabase;
let tmp: string;
let backupDir: string;

beforeEach(() => {
  opened = openDatabase(':memory:');
  tmp = mkdtempSync(path.join(os.tmpdir(), 'sparrow-backup-'));
  backupDir = path.join(tmp, 'exports');
});
afterEach(() => {
  opened.sqlite.close();
  rmSync(tmp, { recursive: true, force: true });
});

const db = (): AppDb => opened.db;

/** A realistic dataset built through the real services: layout, spares, assignment, retirement, pools. */
function seedRealistic(): void {
  seedInitialLayout(db());
  const layout = createLayoutService(db()).getLayout();
  const front = layout.enclosures[0]!.grids.find((g) => g.name === 'Front bays')!;
  const [slot1, slot2] = front.slots.map((s) => s.id);
  const pool = createPool(db(), { name: 'Mirror A', layoutLabel: 'Front' });

  const oldDrive = createDrive(db(), {
    serial: 'OLD-1',
    model: 'Model X',
    capacityBytes: 4_000_787_030_016,
    driveType: 'HDD',
    notes: 'first pull',
  });
  const newDrive = createDrive(db(), { serial: 'new-1', condition: 'new', vendor: 'Acme' });
  const spare = createDrive(db(), { serial: 'SP-9' });

  assignDrive(db(), { driveId: oldDrive.id, slotId: slot1!, poolId: pool.id, role: 'data' });
  assignDrive(db(), { driveId: spare.id, slotId: slot2!, poolId: null, role: null });
  // Retire the old drive; this frees slot1 for the new drive.
  retireDrive(db(), oldDrive.id, {
    reason: 'replaced',
    date: '2026-09-01',
    note: 'SMART errors',
  });
  assignDrive(db(), { driveId: newDrive.id, slotId: slot1!, poolId: pool.id, role: 'hot-spare' });
  updateDrive(db(), newDrive.id, { model: 'Model Y', lastTestDate: '2026-09-02' });
  sendForRma(db(), spare.id, { date: '2026-09-03', note: 'noisy' });
}

/** The export with exportedAt removed, so two exports of the same data compare equal. */
const withoutTime = (file: ExportFile) => ({ ...file, exportedAt: 'x' });

describe('R41, R42: export', () => {
  it('R42: carries the format marker, schema version and the record arrays', () => {
    seedRealistic();
    const file = exportData(db(), new Date('2026-10-10T12:00:00.000Z'));
    expect(file.format).toBe('sparrow-export');
    expect(file.schemaVersion).toBe(2);
    expect(file.exportedAt).toBe('2026-10-10T12:00:00.000Z');
    expect(Object.keys(file.data).sort()).toEqual(
      [
        'appMeta',
        'drives',
        'enclosures',
        'events',
        'grids',
        'memberships',
        'pools',
        'slots',
      ].sort(),
    );
    expect(exportFileSchema.safeParse(file).success).toBe(true);
  });

  it('R41: exports the drives, memberships and events created through the services', () => {
    seedRealistic();
    const { data } = exportData(db());
    expect(data.drives.map((d) => d.serial).sort()).toEqual(['OLD-1', 'SP-9', 'new-1']);
    expect(data.drives.find((d) => d.serial === 'OLD-1')).toMatchObject({
      status: 'retired',
      slotId: null,
    });
    expect(data.memberships.length).toBeGreaterThan(0);
    expect(data.events.map((e) => e.type)).toContain('drive-retired');
    expect(data.appMeta.map((m) => m.key)).toContain('layout.seeded');
  });

  it('R42: excludes the provider snapshot cache', () => {
    seedRealistic();
    db()
      .insert(providerSnapshot)
      .values({
        id: 1,
        providerId: 'scrutiny',
        observations: [
          {
            serial: 'OLD-1',
            health: 'ok',
            lastReportedAt: '2026-10-10T00:00:00.000Z',
            state: 'active',
          },
        ],
        lastSuccessAt: '2026-10-10T00:00:00.000Z',
      })
      .run();
    const json = JSON.stringify(exportData(db()));
    expect(json).not.toContain('scrutiny');
    expect(json).not.toContain('providerId');
    expect(json).not.toContain('observations');
    expect(json).not.toContain('device_status');
  });

  it('is stable: exporting the same data twice gives the same document', () => {
    seedRealistic();
    expect(withoutTime(exportData(db()))).toEqual(withoutTime(exportData(db())));
  });
});

describe('R43: round trip', () => {
  it('export, wipe, import into a fresh database, export again: deep-equal except exportedAt', () => {
    seedRealistic();
    const first = exportData(db(), new Date('2026-10-10T10:00:00.000Z'));

    const fresh = openDatabase(':memory:');
    try {
      importData(fresh.db, JSON.parse(JSON.stringify(first)), {
        backupDir,
        now: new Date('2026-10-10T11:00:00.000Z'),
      });
      const second = exportData(fresh.db, new Date('2026-10-10T12:00:00.000Z'));
      expect(withoutTime(second)).toEqual(withoutTime(first));
    } finally {
      fresh.sqlite.close();
    }
  });

  it('R41, R43, R74: events keep their drive, slot and pool links through export and import', () => {
    seedRealistic();
    const first = exportData(db());
    const withLinks = first.data.events.filter(
      (e) => e.links.drives.length + e.links.slots.length + e.links.pools.length > 0,
    );
    expect(withLinks.length).toBeGreaterThan(5);
    // Every shape is present: a slot link with its copied label, a pool link with its name.
    const retired = first.data.events.find((e) => e.type === 'drive-retired')!;
    expect(retired.links.drives).toEqual([{ driveId: expect.any(String), role: 'subject' }]);
    expect(retired.links.slots[0]).toMatchObject({
      role: 'from',
      slotLabel: '1',
      gridName: 'Front bays',
    });
    const joined = first.data.events.find((e) => e.type === 'pool-joined')!;
    expect(joined.links.pools).toEqual([{ poolId: expect.any(String), poolName: 'Mirror A' }]);

    const fresh = openDatabase(':memory:');
    try {
      importData(fresh.db, JSON.parse(JSON.stringify(first)), { backupDir });
      expect(exportData(fresh.db).data.events).toEqual(first.data.events);
    } finally {
      fresh.sqlite.close();
    }
  });

  it('R43: a successful import over existing data replaces it entirely', () => {
    seedRealistic();
    const original = exportData(db());
    const other = openDatabase(':memory:');
    try {
      createDrive(other.db, { serial: 'UNRELATED' });
      importData(db(), exportData(other.db), { backupDir, now: new Date('2026-10-10T11:00:00Z') });
      expect(withoutTime(exportData(db()))).toEqual(withoutTime(exportData(other.db)));
      expect(exportData(db()).data.drives.map((d) => d.serial)).toEqual(['UNRELATED']);
    } finally {
      other.sqlite.close();
    }
    expect(original.data.drives.length).toBe(3);
  });
});

describe('R44: automatic backup', () => {
  it('writes a valid export of the pre-import data to exports/ before replacing it', () => {
    seedRealistic();
    const before = exportData(db(), new Date('2026-10-10T09:00:00.000Z'));
    const incoming = openDatabase(':memory:');
    try {
      const result = importData(db(), exportData(incoming.db), {
        backupDir,
        now: new Date('2026-10-10T11:22:33.456Z'),
      });
      expect(result.backupPath).toBe(
        path.join(backupDir, 'sparrow-backup-2026-10-10T11-22-33.456Z.json'),
      );
      const written = exportFileSchema.parse(JSON.parse(readFileSync(result.backupPath, 'utf8')));
      expect(withoutTime(written as ExportFile)).toEqual(withoutTime(before));
      expect(written.exportedAt).toBe('2026-10-10T11:22:33.456Z');
    } finally {
      incoming.sqlite.close();
    }
  });

  it('reports the counts of what was imported', () => {
    seedRealistic();
    const file = exportData(db());
    const fresh = openDatabase(':memory:');
    try {
      const { counts } = importData(fresh.db, file, { backupDir });
      expect(counts).toEqual({
        enclosures: file.data.enclosures.length,
        grids: file.data.grids.length,
        slots: file.data.slots.length,
        drives: file.data.drives.length,
        pools: file.data.pools.length,
        memberships: file.data.memberships.length,
        events: file.data.events.length,
        appMeta: file.data.appMeta.length,
      });
    } finally {
      fresh.sqlite.close();
    }
  });

  it('aborts without changes when the backup cannot be written', () => {
    seedRealistic();
    const before = exportData(db());
    const blocker = path.join(tmp, 'not-a-directory');
    writeFileSync(blocker, 'x');
    const incoming = openDatabase(':memory:');
    try {
      expect(() =>
        importData(db(), exportData(incoming.db), { backupDir: path.join(blocker, 'exports') }),
      ).toThrow(/automatic backup/);
    } finally {
      incoming.sqlite.close();
    }
    expect(withoutTime(exportData(db()))).toEqual(withoutTime(before));
  });

  it('does not touch the provider snapshot cache on import', () => {
    seedRealistic();
    const snapshot = {
      id: 1,
      providerId: 'scrutiny',
      observations: [],
      lastSuccessAt: '2026-10-10T00:00:00.000Z',
      lastAttemptAt: null,
      lastError: null,
    };
    db().insert(providerSnapshot).values(snapshot).run();
    const incoming = openDatabase(':memory:');
    try {
      importData(db(), exportData(incoming.db), { backupDir });
    } finally {
      incoming.sqlite.close();
    }
    expect(db().select().from(providerSnapshot).all()).toEqual([snapshot]);
  });
});

describe('R43: failed imports leave data untouched', () => {
  const expectUnchanged = (before: ExportFile) => {
    expect(withoutTime(exportData(db()))).toEqual(withoutTime(before));
  };
  const invalidFrom = (fn: () => unknown): DomainError => {
    try {
      fn();
    } catch (err) {
      if (err instanceof DomainError) return err;
      throw err;
    }
    throw new Error('expected import to fail');
  };

  it('rejects non-export input without writing a backup', () => {
    seedRealistic();
    const before = exportData(db());
    for (const input of [
      null,
      [],
      'nope',
      { format: 'other', schemaVersion: 1 },
      { format: 'sparrow-export' },
    ]) {
      const err = invalidFrom(() => importData(db(), input, { backupDir }));
      expect(err.code).toBe('invalid');
    }
    expectUnchanged(before);
    expect(() => readdirSync(backupDir)).toThrow();
  });

  it('rejects a newer schema version with a clear message', () => {
    seedRealistic();
    const before = exportData(db());
    const file = { ...exportData(db()), schemaVersion: 3 };
    const err = invalidFrom(() => importData(db(), file, { backupDir }));
    expect(err.code).toBe('invalid');
    expect(err.message).toBe(
      'This export was made by a newer Sparrow (schema 3); this version supports up to 2.',
    );
    expectUnchanged(before);
  });

  it('R41, R43: a v1 export (events with a single driveId, no links) is rejected with a clear message and changes nothing', () => {
    seedRealistic();
    const before = exportData(db());
    const v1 = JSON.parse(JSON.stringify(exportData(db()))) as {
      schemaVersion: number;
      data: { events: Record<string, unknown>[] };
    };
    v1.schemaVersion = 1;
    v1.data.events = v1.data.events.map((e) => {
      const old: Record<string, unknown> = { ...e, driveId: null };
      delete old.links; // a v1 event has a single driveId and no links
      return old;
    });
    const err = invalidFrom(() => importData(db(), v1, { backupDir }));
    expect(err.code).toBe('invalid');
    expect(err.message).toBe(
      "This export was made by a pre-release build with an older event format and can't be imported; start fresh.",
    );
    expectUnchanged(before);
    expect(() => readdirSync(backupDir)).toThrow();
  });

  it('R43: an event link to a drive that is not in the file is rejected; links to missing slots and pools are fine', () => {
    seedRealistic();
    const before = exportData(db());
    const file = JSON.parse(JSON.stringify(exportData(db()))) as ExportFile;
    const ev = file.data.events.find((e) => e.type === 'drive-retired')!;
    ev.links.slots[0]!.slotId = 'a-deleted-slot';
    const joined = file.data.events.find((e) => e.type === 'pool-joined')!;
    joined.links.pools[0]!.poolId = 'a-deleted-pool';
    const fresh = openDatabase(':memory:');
    try {
      importData(fresh.db, file, { backupDir });
      expect(
        exportData(fresh.db).data.events.find((e) => e.id === ev.id)!.links.slots[0]!.slotId,
      ).toBe('a-deleted-slot');
    } finally {
      fresh.sqlite.close();
    }
    ev.links.drives[0]!.driveId = 'no-such-drive';
    const err = invalidFrom(() => importData(db(), file, { backupDir }));
    expect(err.code).toBe('invalid');
    expect(JSON.stringify(err.details)).toContain('no-such-drive');
    expectUnchanged(before);
  });

  it('rejects a file that fails schema validation, with the zod issues as details', () => {
    seedRealistic();
    const before = exportData(db());
    const file = exportData(db());
    file.data.drives[0] = { ...file.data.drives[0]!, status: 'bogus' as 'spare' };
    const err = invalidFrom(() => importData(db(), file, { backupDir }));
    expect(err.code).toBe('invalid');
    expect(Array.isArray(err.details)).toBe(true);
    expectUnchanged(before);
  });

  it('rejects a file whose foreign keys point nowhere, before touching the database', () => {
    seedRealistic();
    const before = exportData(db());
    const file = exportData(db());
    file.data.slots[0] = { ...file.data.slots[0]!, gridId: 'missing-grid' };
    const err = invalidFrom(() => importData(db(), file, { backupDir }));
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/broken references/);
    expect(err.details).toEqual([expect.stringContaining('missing-grid')]);
    expectUnchanged(before);
    expect(() => readdirSync(backupDir)).toThrow();
  });

  it('R60: an older export that still has replacedByDriveId imports fine and drops the field', () => {
    seedRealistic();
    const file = exportData(db());
    const old = JSON.parse(JSON.stringify(file)) as {
      data: { drives: Record<string, unknown>[] };
    };
    old.data.drives[0]!.replacedByDriveId = 'ghost-id-not-in-file';
    old.data.drives[1]!.replacedByDriveId = null;
    importData(db(), old, { backupDir });
    const after = exportData(db());
    expect(after.data.drives).toHaveLength(file.data.drives.length);
    for (const d of after.data.drives) expect(d).not.toHaveProperty('replacedByDriveId');
  });

  it('rolls back everything when the database rejects a row mid-insert (duplicate serial)', () => {
    seedRealistic();
    const before = exportData(db());
    const file = exportData(db());
    const dup = { ...file.data.drives[0]! };
    dup.id = 'dup-drive-id';
    dup.serial = 'old-1';
    dup.serialNormalized = 'OLD-1';
    file.data.drives.push(dup);
    file.data.events = [];
    file.data.memberships = [];
    file.data.drives = file.data.drives.map((d) => ({
      ...d,
      slotId: null,
      status: 'spare' as const,
      retirementReason: null,
      retirementDate: null,
      retirementNote: null,
      installedOn: null,
    }));

    const err = invalidFrom(() => importData(db(), file, { backupDir }));
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/rolled it back/);
    expectUnchanged(before);
    // The automatic backup was still written, and it is the pre-import data.
    const [backupName] = readdirSync(backupDir);
    expect(backupName).toMatch(/^sparrow-backup-.*\.json$/);
  });
});

describe('R72: pool expectedMembers in export and import', () => {
  it('round-trips expectedMembers through export and import', () => {
    createPool(db(), { name: 'tank', layoutLabel: null, expectedMembers: 6 });
    const file = exportData(db());
    expect(file.data.pools[0]?.expectedMembers).toBe(6);

    const fresh = openDatabase(':memory:');
    try {
      importData(fresh.db, JSON.parse(JSON.stringify(file)), { backupDir });
      expect(exportData(fresh.db).data.pools[0]?.expectedMembers).toBe(6);
    } finally {
      fresh.sqlite.close();
    }
  });
});
