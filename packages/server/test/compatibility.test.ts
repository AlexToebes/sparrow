import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { poolSummarySchema, slotCompatibilitySchema } from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { assignDrive, removeToSpares, retireDrive } from '../src/core/assignment.js';
import {
  checkSpare,
  commonPoolType,
  getSlotCompatibility,
  usablePoolSize,
  type DriveFacts,
} from '../src/core/compatibility.js';
import { createDrive } from '../src/core/drives.js';
import { createLayoutService } from '../src/core/layout.js';
import { createPool } from '../src/core/pools.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';

const TB = 1e12;
const hdd = (tb: number | null): DriveFacts => ({
  driveType: 'HDD',
  capacityBytes: tb === null ? null : tb * TB,
});

describe('R12: checkSpare (pure)', () => {
  const pool4 = { driveType: 'HDD', sizeBytes: 4 * TB, basis: 'pool' } as const;

  it('R12: same type and capacity >= the target fits (equal counts)', () => {
    expect(checkSpare(hdd(4), pool4).verdict).toBe('fits');
    expect(checkSpare(hdd(8), pool4).verdict).toBe('fits');
  });
  it('R12: a smaller spare is too-small and says what is needed', () => {
    const r = checkSpare(hdd(3), pool4);
    expect(r.verdict).toBe('too-small');
    expect(r.neededBytes).toBe(4 * TB);
    expect(r.reason).toContain('4 TB');
  });
  it('R12: NVMe vs SSD vs HDD are different types, even when large enough', () => {
    const target = { driveType: 'SSD', sizeBytes: 1 * TB, basis: 'drive' } as const;
    expect(checkSpare({ driveType: 'NVMe', capacityBytes: 2 * TB }, target).verdict).toBe(
      'different-type',
    );
    expect(checkSpare({ driveType: 'HDD', capacityBytes: 2 * TB }, target).verdict).toBe(
      'different-type',
    );
    expect(checkSpare({ driveType: 'SSD', capacityBytes: 2 * TB }, target).verdict).toBe('fits');
  });
  it('R12: unknown capacity or type on either side is unknown, not too-small', () => {
    expect(checkSpare(hdd(null), pool4).verdict).toBe('unknown');
    expect(checkSpare(hdd(4), { ...pool4, sizeBytes: null }).verdict).toBe('unknown');
    expect(checkSpare({ driveType: null, capacityBytes: 1 * TB }, pool4).verdict).toBe('unknown');
    expect(checkSpare(hdd(4), { ...pool4, driveType: null }).verdict).toBe('unknown');
  });
  it('R12: a known type mismatch is reported even when the capacity is unknown', () => {
    expect(checkSpare({ driveType: 'SSD', capacityBytes: null }, pool4).verdict).toBe(
      'different-type',
    );
  });
  it('R12: the usable size is the smallest known member; unknown capacities are skipped', () => {
    expect(usablePoolSize([hdd(4), hdd(2), hdd(3)])).toBe(2 * TB);
    expect(usablePoolSize([hdd(null), hdd(3)])).toBe(3 * TB);
    expect(usablePoolSize([hdd(null)])).toBeNull();
    expect(usablePoolSize([])).toBeNull();
  });
  it('R12: the pool type is the one known type its members share', () => {
    expect(commonPoolType([hdd(1), hdd(2)])).toBe('HDD');
    expect(commonPoolType([hdd(1), { driveType: 'SSD', capacityBytes: 1 }])).toBeNull();
    expect(commonPoolType([{ driveType: null, capacityBytes: 1 }])).toBeNull();
  });
});

let opened: OpenedDatabase;
let app: FastifyInstance;
let slots: string[];
beforeEach(async () => {
  opened = openDatabase(':memory:');
  app = buildApp({ db: opened.db });
  await app.ready();
  const layout = createLayoutService(opened.db);
  const enc = layout.createEnclosure({ name: 'NAS' });
  layout.createGrid(enc.id, { name: 'Front', rows: 1, columns: 6, orientation: 'landscape' });
  slots = layout.getLayout().enclosures[0]!.grids[0]!.slots.map((s) => s.id);
});
afterEach(async () => {
  await app.close();
  opened.sqlite.close();
});

const db = () => opened.db;
const make = (serial: string, tb: number | null, driveType: 'HDD' | 'SSD' | 'NVMe' = 'HDD') =>
  createDrive(db(), {
    serial,
    driveType,
    ...(tb === null ? {} : { capacityBytes: tb * TB }),
  });
const install = (serial: string, tb: number | null, slot: number, poolId: string | null = null) => {
  const d = make(serial, tb);
  assignDrive(db(), { driveId: d.id, slotId: slots[slot]!, poolId });
  return d;
};
const verdictOf = (slot: number, driveId: string) =>
  getSlotCompatibility(db(), slots[slot]!).spares.find((s) => s.driveId === driveId)!;

describe('R12: getSlotCompatibility', () => {
  it('R12: mixed pool `big` (2, 3, 4 TB): the target is the smallest member, not the replaced drive', () => {
    const big = createPool(db(), { name: 'big' });
    install('A4', 4, 0, big.id);
    install('B3', 3, 1, big.id);
    install('C2', 2, 2, big.id);
    const s2 = make('S2', 2);
    const s3 = make('S3', 3);
    const s1 = make('S1', 1);
    // Replacing the 4 TB drive: a 2 TB spare fits because the vdev is limited to 2 TB.
    expect(verdictOf(0, s2.id).verdict).toBe('fits');
    expect(verdictOf(0, s3.id).verdict).toBe('fits');
    const small = verdictOf(0, s1.id);
    expect(small.verdict).toBe('too-small');
    expect(small.neededBytes).toBe(2 * TB);
    expect(getSlotCompatibility(db(), slots[0]!).target).toMatchObject({
      basis: 'pool',
      poolName: 'big',
      sizeBytes: 2 * TB,
      serial: 'A4',
    });
  });

  it('R12: the outgoing drive is the smallest member, so its own size is the target', () => {
    const big = createPool(db(), { name: 'big' });
    install('A4', 4, 0, big.id);
    install('C2', 2, 1, big.id);
    const s3 = make('S3', 3);
    const s1 = make('S1', 1);
    expect(verdictOf(1, s3.id).verdict).toBe('fits');
    expect(verdictOf(1, s1.id).verdict).toBe('too-small');
  });

  it("R12: with no pool the occupant's own capacity is the target", () => {
    install('X3', 3, 0);
    const s4 = make('S4', 4);
    const s2 = make('S2', 2);
    expect(verdictOf(0, s4.id).verdict).toBe('fits');
    expect(verdictOf(0, s2.id)).toMatchObject({ verdict: 'too-small', neededBytes: 3 * TB });
    expect(getSlotCompatibility(db(), slots[0]!).target).toMatchObject({
      basis: 'drive',
      poolName: null,
    });
  });

  it("R12: an empty bay uses its previous occupant and that occupant's pool (R35)", () => {
    const big = createPool(db(), { name: 'big' });
    const out = install('A4', 4, 0, big.id);
    install('C2', 2, 1, big.id);
    removeToSpares(db(), out.id, {});
    const s2 = make('S2', 2);
    const s1 = make('S1', 1);
    expect(verdictOf(0, s2.id).verdict).toBe('fits');
    expect(verdictOf(0, s1.id).verdict).toBe('too-small');
    expect(getSlotCompatibility(db(), slots[0]!).target?.serial).toBe('A4');
  });

  it('R12: a bay whose previous occupant was retired still checks against it', () => {
    const out = install('R3', 3, 0);
    retireDrive(db(), out.id, { reason: 'failed' });
    const s4 = make('S4', 4);
    expect(verdictOf(0, s4.id).verdict).toBe('fits');
  });

  it('R12: an empty bay with no history has no target and no verdicts', () => {
    make('S4', 4);
    const r = getSlotCompatibility(db(), slots[3]!);
    expect(r.target).toBeNull();
    expect(r.spares).toEqual([]);
  });

  it('R12: unknown capacity (occupant or spare) is unknown, and types are compared', () => {
    install('U', null, 0);
    const s4 = make('S4', 4);
    expect(verdictOf(0, s4.id).verdict).toBe('unknown');
    install('H3', 3, 1);
    const nvme = make('N4', 4, 'NVMe');
    const ssd = make('SS4', 4, 'SSD');
    const noCap = make('NC', null);
    expect(verdictOf(1, nvme.id).verdict).toBe('different-type');
    expect(verdictOf(1, ssd.id).verdict).toBe('different-type');
    expect(verdictOf(1, noCap.id).verdict).toBe('unknown');
  });

  it('R12: only spares are listed, and an unknown slot is a 404', async () => {
    install('X3', 3, 0);
    const s = make('S4', 4);
    const other = install('X4', 4, 1);
    const ids = getSlotCompatibility(db(), slots[0]!).spares.map((v) => v.driveId);
    expect(ids).toEqual([s.id]);
    expect(ids).not.toContain(other.id);
    const res = await app.inject({ method: 'GET', url: '/api/slots/nope/compatibility' });
    expect(res.statusCode).toBe(404);
  });
});

describe('R12: API', () => {
  it('R12: GET /api/slots/:id/compatibility matches the shared schema', async () => {
    const big = createPool(db(), { name: 'big' });
    install('A4', 4, 0, big.id);
    install('C2', 2, 1, big.id);
    const s2 = make('S2', 2);
    const res = await app.inject({ method: 'GET', url: `/api/slots/${slots[0]}/compatibility` });
    expect(res.statusCode).toBe(200);
    const body = slotCompatibilitySchema.parse(res.json());
    expect(body.spares).toEqual([
      expect.objectContaining({ driveId: s2.id, verdict: 'fits', neededBytes: null }),
    ]);
  });

  it('R12: the pool summary reports the smallest member and how many spares fit', async () => {
    const big = createPool(db(), { name: 'big' });
    install('A4', 4, 0, big.id);
    install('B3', 3, 1, big.id);
    install('C2', 2, 2, big.id);
    make('S2', 2);
    make('S8', 8);
    make('S1', 1);
    make('N8', 8, 'NVMe');
    const list = async () =>
      poolSummarySchema
        .array()
        .parse((await app.inject({ method: 'GET', url: '/api/pools' })).json());
    const pool = (await list())[0]!;
    expect(pool.smallestMemberBytes).toBe(2 * TB);
    expect(pool.sparesFit).toBe(2);
    const empty = createPool(db(), { name: 'empty' });
    expect((await list()).find((p) => p.id === empty.id)).toMatchObject({
      smallestMemberBytes: null,
      sparesFit: 0,
    });
  });
});
