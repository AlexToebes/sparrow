import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  activitySchema,
  enclosureSchema,
  gridSchema,
  installationSchema,
  poolSchema,
  slotSchema,
  storedActivitySchema,
  storedDriveSchema,
} from '@sparrow/shared';
import { driveSchema } from '@sparrow/shared';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { listDriveActivities, recordActivity, type DbTransaction } from '../src/core/activities.js';
import { listDrives } from '../src/core/drives.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';

// Proves that rows produced by the repositories satisfy the shared zod schemas
// (DB and API/export contracts agree).

let opened: OpenedDatabase;
let repo: Repositories;

beforeEach(() => {
  opened = openDatabase(':memory:');
  repo = createRepositories(opened.db);
});
afterEach(() => opened.sqlite.close());

const recordIn = <T>(fn: (tx: DbTransaction) => T): T => opened.db.transaction(fn);

describe('repository records match shared schemas', () => {
  it('enclosure, grid and slot', () => {
    const enclosure = repo.enclosures.create({ name: 'NAS' });
    expect(enclosureSchema.parse(enclosure)).toEqual(enclosure);

    const grid = repo.grids.create({
      enclosureId: enclosure.id,
      name: 'Front',
      rows: 2,
      columns: 4,
      orientation: 'portrait',
    });
    expect(gridSchema.parse(grid)).toEqual(grid);

    const slot = repo.slots.create({ gridId: grid.id, position: 0, label: null });
    expect(slotSchema.parse(slot)).toEqual(slot);
    const labelled = repo.slots.create({ gridId: grid.id, position: 1, label: 'Bay 2' });
    expect(slotSchema.parse(labelled)).toEqual(labelled);
  });

  it('drive: a spare with only required fields, and fully populated and retired drives (stored and API views)', () => {
    const spare = repo.drives.create({ serial: ' ab-12 ' });
    expect(storedDriveSchema.parse(spare)).toEqual(spare);

    const full = repo.drives.create({
      serial: 'INS-1',
      model: 'WD Red',
      capacityBytes: 4_000_787_030_016,
      driveType: 'HDD',
      formFactor: '3.5',
      storageLocation: 'bay 1',
      condition: 'used',
      lastTestDate: '2026-01-02',
      purchaseDate: '2024-05-06',
      warrantyExpiry: '2029-05-06',
      vendor: 'WD',
      notes: 'noisy',
    });
    expect(storedDriveSchema.parse(full)).toEqual(full);

    const retired = repo.drives.create({
      serial: 'OLD-1',
      retirementReason: 'replaced',
      retirementDate: '2026-03-04',
      retirementNote: 'SMART failures',
      driveType: 'NVMe',
      condition: 'tested',
    });
    expect(storedDriveSchema.parse(retired)).toEqual(retired);

    // The API view adds the computed status and the installation fields; all of them satisfy driveSchema.
    const enclosure = repo.enclosures.create({ name: 'NAS' });
    const grid = repo.grids.create({
      enclosureId: enclosure.id,
      name: 'Front',
      rows: 1,
      columns: 1,
      orientation: 'landscape',
    });
    const slot = repo.slots.create({ gridId: grid.id, position: 0, label: null });
    const pool = repo.pools.create({ name: 'tank', layoutLabel: null });
    repo.installations.create({
      driveId: full.id,
      slotId: slot.id,
      poolId: pool.id,
      poolRole: 'data',
      installedOn: '2025-01-02',
    });
    const view = listDrives(opened.db);
    expect(view.map((d) => [d.serial, d.status])).toEqual([
      ['ab-12', 'spare'],
      ['INS-1', 'installed'],
      ['OLD-1', 'retired'],
    ]);
    expect(view.find((d) => d.status === 'installed')).toMatchObject({
      slotId: slot.id,
      installedOn: '2025-01-02',
      poolId: pool.id,
      poolRole: 'data',
    });
    for (const d of view) expect(driveSchema.parse(d)).toEqual(d);
  });

  it('pool', () => {
    const plain = repo.pools.create({ name: 'scratch', layoutLabel: null });
    expect(poolSchema.parse(plain)).toEqual(plain);
    const tank = repo.pools.create({ name: 'tank', layoutLabel: 'raidz2' });
    expect(poolSchema.parse(tank)).toEqual(tank);
  });

  it('installation, with and without a pool', () => {
    const enclosure = repo.enclosures.create({ name: 'NAS' });
    const grid = repo.grids.create({
      enclosureId: enclosure.id,
      name: 'Front',
      rows: 1,
      columns: 2,
      orientation: 'landscape',
    });
    const [s1, s2] = [0, 1].map((position) =>
      repo.slots.create({ gridId: grid.id, position, label: null }),
    );
    const d1 = repo.drives.create({ serial: 'M1' });
    const d2 = repo.drives.create({ serial: 'M2' });
    const pool = repo.pools.create({ name: 'tank', layoutLabel: null });
    const withPool = repo.installations.create({
      driveId: d1.id,
      slotId: s1!.id,
      poolId: pool.id,
      poolRole: 'hot-spare',
      installedOn: '2026-01-01',
    });
    expect(installationSchema.parse(withPool)).toEqual(withPool);
    const plain = repo.installations.create({ driveId: d2.id, slotId: s2!.id });
    expect(installationSchema.parse(plain)).toEqual(plain);
    expect(plain).toEqual({
      driveId: d2.id,
      slotId: s2!.id,
      poolId: null,
      poolRole: null,
      installedOn: null,
    });
  });

  it('activity: events with and without drive, bay and pool round-trip through the stored and API schemas', () => {
    const drive = repo.drives.create({ serial: 'E1' });
    const stored = recordIn((tx) =>
      recordActivity(tx, {
        kind: 'drive-edited',
        events: [
          {
            type: 'drive-updated',
            driveId: drive.id,
            payload: { changes: { model: { from: null, to: 'X' } }, n: 2 },
          },
          { type: 'pool-created', poolId: undefined, payload: {} },
        ],
      }),
    );
    expect(storedActivitySchema.parse(stored)).toEqual(stored);
    expect(stored.events[0]).toMatchObject({ driveId: drive.id, slotId: null, poolId: null });
    expect(stored.events[1]).toMatchObject({ driveId: null, payload: {} });
    // The API view resolves the drive for display and satisfies its own schema.
    const [shown] = listDriveActivities(opened.db, drive.id);
    expect(activitySchema.parse(shown)).toEqual(shown);
    expect(shown!.events[0]!.drive).toEqual({ serial: 'E1', capacityBytes: null, driveType: null });
    expect(shown!.events[1]!.drive).toBeNull();
  });
});

describe('length caps (R11, R30, R38, R39)', () => {
  it('pool, label and name caps apply to request schemas and records', async () => {
    const shared = await import('@sparrow/shared');
    const long = (n: number) => 'x'.repeat(n);
    expect(shared.createPoolInputSchema.safeParse({ name: long(101) }).success).toBe(false);
    expect(shared.createPoolInputSchema.safeParse({ name: long(100) }).success).toBe(true);
    expect(
      shared.createPoolInputSchema.safeParse({ name: 'p', layoutLabel: long(51) }).success,
    ).toBe(false);
    expect(shared.createEnclosureSchema.safeParse({ name: long(101) }).success).toBe(false);
    expect(shared.updateSlotSchema.safeParse({ label: long(51) }).success).toBe(false);
    expect(
      shared.retireDriveInputSchema.safeParse({ reason: 'other', note: long(5001) }).success,
    ).toBe(false);
  });

  it('R60: retire, RMA, occupant and import-retired dates are optional and nullable', async () => {
    const shared = await import('@sparrow/shared');
    const ok = (schema: { safeParse: (v: unknown) => { success: boolean } }, v: unknown) =>
      schema.safeParse(v).success;
    expect(ok(shared.retireDriveInputSchema, { reason: 'other' })).toBe(true);
    expect(ok(shared.retireDriveInputSchema, { reason: 'other', date: null })).toBe(true);
    expect(ok(shared.retireDriveInputSchema, { reason: 'other', date: '2026-01-02' })).toBe(true);
    expect(ok(shared.retireDriveInputSchema, { reason: 'other', date: '02/01/2026' })).toBe(false);
    expect(ok(shared.retireDriveInputSchema, { date: null })).toBe(false);
    expect(ok(shared.rmaInputSchema, { date: null })).toBe(true);
    expect(ok(shared.occupantResolutionSchema, { action: 'retire', reason: 'failed' })).toBe(true);
    expect(
      ok(shared.occupantResolutionSchema, { action: 'retire', reason: 'failed', date: null }),
    ).toBe(true);
    expect(ok(shared.occupantResolutionSchema, { action: 'rma', date: null })).toBe(true);
    const item = { observationKey: 'K', reason: 'failed' };
    expect(ok(shared.importRetiredInputSchema, { items: [item] })).toBe(true);
    expect(ok(shared.importRetiredInputSchema, { items: [{ ...item, date: null }] })).toBe(true);
    expect(
      ok(shared.importRetiredInputSchema, { items: [{ observationKey: 'K', date: null }] }),
    ).toBe(false);
  });
});
