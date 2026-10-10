import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  driveSchema,
  enclosureSchema,
  eventSchema,
  gridSchema,
  membershipSchema,
  poolSchema,
  slotSchema,
} from '@sparrow/shared';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
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

  it('drive: spare with only required fields, and fully populated installed and retired drives', () => {
    const spare = repo.drives.create({ serial: ' ab-12 ', status: 'spare' });
    expect(driveSchema.parse(spare)).toEqual(spare);

    const enclosure = repo.enclosures.create({ name: 'NAS' });
    const grid = repo.grids.create({
      enclosureId: enclosure.id,
      name: 'Front',
      rows: 1,
      columns: 1,
      orientation: 'landscape',
    });
    const slot = repo.slots.create({ gridId: grid.id, position: 0, label: null });
    const installed = repo.drives.create({
      serial: 'INS-1',
      status: 'installed',
      slotId: slot.id,
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
    expect(driveSchema.parse(installed)).toEqual(installed);

    const retired = repo.drives.create({
      serial: 'OLD-1',
      status: 'retired',
      retirementReason: 'replaced',
      retirementDate: '2026-03-04',
      replacedByDriveId: installed.id,
      retirementNote: 'SMART failures',
      driveType: 'NVMe',
      condition: 'tested',
    });
    expect(driveSchema.parse(retired)).toEqual(retired);
  });

  it('pool', () => {
    const plain = repo.pools.create({ name: 'scratch', layoutLabel: null });
    expect(poolSchema.parse(plain)).toEqual(plain);
    const tank = repo.pools.create({ name: 'tank', layoutLabel: 'raidz2' });
    expect(poolSchema.parse(tank)).toEqual(tank);
  });

  it('membership, open and closed', () => {
    const drive = repo.drives.create({ serial: 'M1', status: 'spare' });
    const pool = repo.pools.create({ name: 'tank', layoutLabel: null });
    const open = repo.memberships.create({
      driveId: drive.id,
      poolId: pool.id,
      role: 'data',
      source: 'manual',
      startedAt: '2026-01-01T00:00:00.000Z',
      endedAt: null,
    });
    expect(membershipSchema.parse(open)).toEqual(open);
    const closed = repo.memberships.create({
      driveId: drive.id,
      poolId: pool.id,
      role: 'hot-spare',
      source: 'manual',
      startedAt: '2025-01-01T00:00:00.000Z',
      endedAt: '2025-06-01T00:00:00.000Z',
    });
    expect(membershipSchema.parse(closed)).toEqual(closed);
  });

  it('event: JSON payload round-trips as an object, with and without a drive', () => {
    const drive = repo.drives.create({ serial: 'E1', status: 'spare' });
    const withDrive = repo.events.create({
      driveId: drive.id,
      type: 'drive-updated',
      payload: { changed: ['model'], before: { model: null }, after: { model: 'X' }, n: 2 },
    });
    expect(typeof withDrive.payload).toBe('object');
    expect(eventSchema.parse(withDrive)).toEqual(withDrive);

    const noDrive = repo.events.create({ driveId: null, type: 'pool-joined', payload: {} });
    expect(eventSchema.parse(noDrive)).toEqual(noDrive);
    expect(noDrive.payload).toEqual({});
  });
});
