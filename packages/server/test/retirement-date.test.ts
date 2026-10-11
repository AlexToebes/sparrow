import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { assignDrive, reinstateDrive, retireDrive, sendForRma } from '../src/core/assignment.js';
import { exportData, importData } from '../src/core/backup.js';
import { createDrive, getDrive } from '../src/core/drives.js';
import { DomainError } from '../src/core/errors.js';
import { listDriveEvents } from '../src/core/events.js';
import { createLayoutService } from '../src/core/layout.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { memberships, pools } from '../src/db/schema.js';
import type { DriveDataProvider } from '../src/core/provider-port.js';

let opened: OpenedDatabase;
let app: FastifyInstance;
beforeEach(async () => {
  opened = openDatabase(':memory:');
  const provider: DriveDataProvider = {
    id: 'fake',
    capabilities: { drives: true, pools: false },
    expectedUpdateIntervalHours: 1,
    fetchSnapshot: async () => [],
    checkConnection: async () => ({ ok: true }),
  };
  app = buildApp({ db: opened.db, provider });
  await app.ready();
});
afterEach(async () => {
  await app.close();
  opened.sqlite.close();
});

const db = () => opened.db;
const TODAY = () => new Date().toISOString().slice(0, 10);
const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);

function slotIds(): string[] {
  const layout = createLayoutService(db());
  const enclosure = layout.createEnclosure({ name: 'NAS' });
  layout.createGrid(enclosure.id, { name: 'Front', rows: 1, columns: 3, orientation: 'landscape' });
  return layout
    .getLayout()
    .enclosures.flatMap((e) => e.grids.flatMap((g) => g.slots.map((s) => s.id)));
}
function makePool(name = 'tank'): string {
  const at = new Date().toISOString();
  db()
    .insert(pools)
    .values({ id: `pool-${name}`, name, layoutLabel: null, createdAt: at, updatedAt: at })
    .run();
  return `pool-${name}`;
}
const spare = (serial: string) => createDrive(db(), { serial });
const event = (driveId: string, type: string) =>
  listDriveEvents(db(), driveId).find((e) => e.type === type)!;
const members = (driveId: string) =>
  db().select().from(memberships).where(eq(memberships.driveId, driveId)).all();
function thrown(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (e) {
    return e as DomainError;
  }
  throw new Error('expected a throw');
}

const tomorrow2 = () => new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);

describe('R60: retirement date is optional (not recorded rather than guessed)', () => {
  it('R60: retire with the date omitted records today; a past date is kept; null is not recorded', () => {
    const a = spare('A');
    const b = spare('B');
    const c = spare('C');
    expect(retireDrive(db(), a.id, { reason: 'failed' }).retirementDate).toBe(TODAY());
    expect(retireDrive(db(), b.id, { reason: 'failed', date: daysAgo(9) }).retirementDate).toBe(
      daysAgo(9),
    );
    const nullDate = retireDrive(db(), c.id, { reason: 'other', date: null });
    expect(nullDate).toMatchObject({
      status: 'retired',
      retirementReason: 'other',
      retirementDate: null,
    });
    expect(event(c.id, 'drive-retired').payload).toMatchObject({ reason: 'other', date: null });
  });

  it('R60: a future retirement date is rejected and changes nothing', () => {
    const a = spare('A');
    const err = thrown(() => retireDrive(db(), a.id, { reason: 'failed', date: tomorrow2() }));
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/future/);
    expect(getDrive(db(), a.id).status).toBe('spare');
    expect(
      thrown(() => retireDrive(db(), a.id, { reason: 'failed', date: '2026-13-40' })).code,
    ).toBe('invalid');
  });

  it('R60, R69: retiring an installed drive with no date writes drive-removed.removedOn null and the retired event null', () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: pool });
    retireDrive(db(), d.id, { reason: 'failed', date: null });
    expect(event(d.id, 'drive-removed').payload).toMatchObject({ removedOn: null });
    expect(event(d.id, 'drive-retired').payload).toMatchObject({ date: null });
    expect(members(d.id)[0]!.endedAt).not.toBeNull();
  });

  it('R60, R69: a dated retirement is the removedOn of the drive-removed event', () => {
    const [slot] = slotIds();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: null });
    retireDrive(db(), d.id, { reason: 'failed', date: daysAgo(3) });
    expect(event(d.id, 'drive-removed').payload).toMatchObject({ removedOn: daysAgo(3) });
    expect(event(d.id, 'drive-retired').payload).toMatchObject({ date: daysAgo(3) });
  });

  it('R60, R27: RMA omitted = today, null = not recorded, future rejected', () => {
    const a = spare('A');
    const b = spare('B');
    const c = spare('C');
    expect(sendForRma(db(), a.id).retirementDate).toBe(TODAY());
    const nulled = sendForRma(db(), b.id, { date: null });
    expect(nulled.retirementDate).toBeNull();
    expect(event(b.id, 'drive-sent-for-rma').payload).toMatchObject({ date: null });
    expect(event(b.id, 'drive-retired').payload).toMatchObject({ date: null });
    expect(thrown(() => sendForRma(db(), c.id, { date: tomorrow2() })).code).toBe('invalid');
    expect(getDrive(db(), c.id).status).toBe('spare');
  });

  it('R60, R62: occupant retire/rma with a null date, an omitted date, and a future date (rolled back)', () => {
    const [s1, s2, s3] = slotIds();
    const o1 = spare('O1');
    const o2 = spare('O2');
    const o3 = spare('O3');
    const n1 = spare('N1');
    const n2 = spare('N2');
    const n3 = spare('N3');
    assignDrive(db(), { driveId: o1.id, slotId: s1!, poolId: null });
    const r1 = assignDrive(db(), {
      driveId: n1.id,
      slotId: s1!,
      occupant: { action: 'retire', reason: 'replaced', date: null },
    });
    expect(r1.occupant).toMatchObject({ status: 'retired', retirementDate: null });
    expect(event(o1.id, 'drive-removed').payload).toMatchObject({ removedOn: null });

    assignDrive(db(), { driveId: o2.id, slotId: s2!, poolId: null });
    const r2 = assignDrive(db(), {
      driveId: n2.id,
      slotId: s2!,
      occupant: { action: 'rma', date: null },
    });
    expect(r2.occupant).toMatchObject({ status: 'retired', retirementDate: null });
    expect(event(o2.id, 'drive-sent-for-rma').payload).toMatchObject({ date: null });

    // Omitted date on the occupant retire is today.
    const r3 = assignDrive(db(), {
      driveId: n3.id,
      slotId: s1!,
      occupant: { action: 'retire', reason: 'failed' },
    });
    expect(r3.occupant?.retirementDate).toBe(TODAY());

    // A future date is rejected and the slot stays as it was.
    const n4 = spare('N4');
    assignDrive(db(), { driveId: o3.id, slotId: s3!, poolId: null });
    const err = thrown(() =>
      assignDrive(db(), {
        driveId: n4.id,
        slotId: s3!,
        occupant: { action: 'rma', date: tomorrow2() },
      }),
    );
    expect(err.code).toBe('invalid');
    expect(getDrive(db(), o3.id)).toMatchObject({ status: 'installed', slotId: s3 });
    expect(getDrive(db(), n4.id).status).toBe('spare');
  });

  it('R60: reinstating a drive retired without a date keeps previousDate null in the event', () => {
    const d = spare('A');
    retireDrive(db(), d.id, { reason: 'failed', date: null });
    const back = reinstateDrive(db(), d.id);
    expect(back).toMatchObject({ status: 'spare', retirementDate: null, retirementReason: null });
    expect(event(d.id, 'drive-reinstated').payload).toMatchObject({
      previousReason: 'failed',
      previousDate: null,
    });
  });

  it('R60, R42: a retired drive with a null date round-trips through export and import', () => {
    const d = spare('A');
    retireDrive(db(), d.id, { reason: 'failed', date: null });
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'sparrow-retired-'));
    const first = exportData(db());
    const fresh = openDatabase(':memory:');
    try {
      importData(fresh.db, JSON.parse(JSON.stringify(first)), { backupDir: tmp });
      const again = exportData(fresh.db);
      expect(again.data.drives).toEqual(first.data.drives);
      expect(again.data.drives[0]).toMatchObject({ status: 'retired', retirementDate: null });
      expect(again.schemaVersion).toBe(1);
    } finally {
      fresh.sqlite.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('R60: an import file that states retired without a reason is still rejected', () => {
    const d = spare('A');
    retireDrive(db(), d.id, { reason: 'failed', date: null });
    const file = JSON.parse(JSON.stringify(exportData(db())));
    file.data.drives[0].retirementReason = null;
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'sparrow-retired-'));
    try {
      expect(() => importData(db(), file, { backupDir: tmp })).toThrow();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('R60: the API takes date null, omitted, and rejects future dates and bad types', async () => {
    const a = spare('A');
    const b = spare('B');
    const c = spare('C');
    const d = spare('D');
    const nul = await app.inject({
      method: 'POST',
      url: `/api/drives/${a.id}/retire`,
      payload: { reason: 'failed', date: null },
    });
    expect(nul.statusCode).toBe(200);
    expect(nul.json()).toMatchObject({ status: 'retired', retirementDate: null });
    const omitted = await app.inject({
      method: 'POST',
      url: `/api/drives/${b.id}/retire`,
      payload: { reason: 'failed' },
    });
    expect(omitted.json()).toMatchObject({ retirementDate: TODAY() });
    const future = await app.inject({
      method: 'POST',
      url: `/api/drives/${c.id}/retire`,
      payload: { reason: 'failed', date: tomorrow2() },
    });
    expect(future.statusCode).toBe(400);
    const rma = await app.inject({
      method: 'POST',
      url: `/api/drives/${d.id}/rma`,
      payload: { date: null },
    });
    expect(rma.statusCode).toBe(200);
    expect(rma.json()).toMatchObject({ retirementDate: null });
    const noReason = await app.inject({
      method: 'POST',
      url: `/api/drives/${c.id}/retire`,
      payload: { date: null },
    });
    expect(noReason.statusCode).toBe(400);
    expect(getDrive(db(), c.id).status).toBe('spare');
  });
});
