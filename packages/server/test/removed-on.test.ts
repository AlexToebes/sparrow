import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/api/app.js';
import { assignDrive, removeToSpares, retireDrive, sendForRma } from '../src/core/assignment.js';
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

describe('R69: removal date when a drive goes back to the spares', () => {
  it('R69, R14: a past removal date is kept in drive-removed and backdates the membership end; the event is stamped now', () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: pool, installedOn: daysAgo(60) });
    const date = daysAgo(5);
    const before = Date.now();
    removeToSpares(db(), d.id, { removedOn: date });
    const removed = event(d.id, 'drive-removed');
    expect(removed.payload).toMatchObject({ removedOn: date });
    expect(Date.parse(removed.at)).toBeGreaterThanOrEqual(before - 1000);
    expect(members(d.id)[0]!.endedAt).toBe(`${date}T00:00:00.000Z`);
    expect(event(d.id, 'pool-left').payload).toMatchObject({ endedAt: `${date}T00:00:00.000Z` });
    expect(Date.parse(event(d.id, 'pool-left').at)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('R69: without removedOn the removal date is today and the membership ends now', () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: pool, installedOn: daysAgo(60) });
    const before = Date.now();
    removeToSpares(db(), d.id);
    expect(event(d.id, 'drive-removed').payload).toMatchObject({ removedOn: TODAY() });
    expect(Date.parse(members(d.id)[0]!.endedAt!)).toBeGreaterThanOrEqual(before - 1000);
    expect(event(d.id, 'pool-left').payload).not.toHaveProperty('endedAt');
  });

  it('R69: an explicit null records no removal date; the membership ends now', () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: pool, installedOn: daysAgo(60) });
    const before = Date.now();
    removeToSpares(db(), d.id, { removedOn: null });
    expect(event(d.id, 'drive-removed').payload).toMatchObject({ removedOn: null });
    expect(Date.parse(members(d.id)[0]!.endedAt!)).toBeGreaterThanOrEqual(before - 1000);
    expect(event(d.id, 'pool-left').payload).not.toHaveProperty('endedAt');
  });

  it('R69: a removal date later than today is rejected (400) and nothing changes', () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: pool, installedOn: daysAgo(60) });
    const err = thrown(() => removeToSpares(db(), d.id, { removedOn: daysAgo(-3) }));
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/removedOn must not be in the future/);
    expect(getDrive(db(), d.id).status).toBe('installed');
    expect(members(d.id)[0]!.endedAt).toBeNull();
    expect(listDriveEvents(db(), d.id).map((e) => e.type)).not.toContain('drive-removed');
  });

  it('R69: a malformed removal date is rejected (400)', () => {
    const [slot] = slotIds();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, installedOn: daysAgo(60) });
    const err = thrown(() => removeToSpares(db(), d.id, { removedOn: '3/4/2026' }));
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/removedOn must be a valid date/);
    expect(getDrive(db(), d.id).status).toBe('installed');
  });

  it('R69, R68: a removal date before the installation date is rejected and nothing changes', () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: pool, installedOn: '2025-05-05' });
    const err = thrown(() => removeToSpares(db(), d.id, { removedOn: '2025-05-04' }));
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(
      /can't be removed before it was installed \(installed on 2025-05-05\)/,
    );
    expect(getDrive(db(), d.id).status).toBe('installed');
    expect(members(d.id)[0]!.endedAt).toBeNull();
    expect(listDriveEvents(db(), d.id).map((e) => e.type)).not.toContain('drive-removed');
  });

  it('R69, R29: a removal date before the drive joined the pool is rejected and nothing changes', () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    // No installation date, so the membership starts now and only the membership guard applies.
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: pool, installedOn: null });
    const err = thrown(() => removeToSpares(db(), d.id, { removedOn: daysAgo(3) }));
    expect(err.code).toBe('invalid');
    expect(err.message).toMatch(/before it joined the pool/);
    expect(getDrive(db(), d.id).status).toBe('installed');
    expect(members(d.id)[0]!.endedAt).toBeNull();
    expect(listDriveEvents(db(), d.id).map((e) => e.type)).not.toContain('pool-left');
  });

  it('R69, R37: occupant { action: "spare", removedOn } backdates the old occupant and keeps its date in drive-replaced', () => {
    const [slot] = slotIds();
    const pool = makePool();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slot!, poolId: pool, installedOn: daysAgo(90) });
    const date = daysAgo(30);
    const out = assignDrive(db(), {
      driveId: b.id,
      slotId: slot!,
      installedOn: daysAgo(30),
      occupant: { action: 'spare', removedOn: date },
    });
    expect(out.occupant!.status).toBe('spare');
    expect(event(a.id, 'drive-replaced').payload).toMatchObject({
      outgoing: { outcome: 'spares', date },
    });
    expect(members(a.id)[0]!.endedAt).toBe(`${date}T00:00:00.000Z`);
    expect(getDrive(db(), b.id).status).toBe('installed');
  });

  it('R69, R37: occupant { action: "spare" } without removedOn records today', () => {
    const [slot] = slotIds();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slot!, installedOn: daysAgo(90) });
    assignDrive(db(), { driveId: b.id, slotId: slot!, occupant: { action: 'spare' } });
    expect(event(a.id, 'drive-replaced').payload).toMatchObject({
      outgoing: { outcome: 'spares', date: TODAY() },
    });
  });

  it('R69, R60, R27: a retired / RMA drive leaves the bay on its retirement date (slot from)', () => {
    const [s1, s2] = slotIds();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: s1!, installedOn: '2025-01-01' });
    assignDrive(db(), { driveId: b.id, slotId: s2!, installedOn: '2025-01-01' });
    retireDrive(db(), a.id, { reason: 'failed', date: '2026-01-02' });
    sendForRma(db(), b.id, { date: '2026-03-04' });
    expect(event(a.id, 'drive-retired').payload).toMatchObject({ date: '2026-01-02' });
    expect(event(a.id, 'drive-retired').links.slots.map((l) => l.role)).toEqual(['from']);
    expect(event(b.id, 'drive-sent-for-rma').payload).toMatchObject({ date: '2026-03-04' });
    expect(event(b.id, 'drive-sent-for-rma').links.slots.map((l) => l.role)).toEqual(['from']);
  });

  it('R69, R60: retire defaults the date it left the bay to today', () => {
    const [slot] = slotIds();
    const a = spare('A');
    assignDrive(db(), { driveId: a.id, slotId: slot!, installedOn: '2025-01-01' });
    retireDrive(db(), a.id, { reason: 'other' });
    expect(event(a.id, 'drive-retired').payload).toMatchObject({ date: TODAY() });
  });

  it('R69, R43: removedOn survives an export, import and export round trip', () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: pool, installedOn: daysAgo(60) });
    removeToSpares(db(), d.id, { removedOn: daysAgo(5) });
    const tmp = mkdtempSync(path.join(os.tmpdir(), 'sparrow-removed-'));
    const first = exportData(db());
    const fresh = openDatabase(':memory:');
    try {
      importData(fresh.db, JSON.parse(JSON.stringify(first)), { backupDir: tmp });
      const again = exportData(fresh.db);
      expect(again.data.drives).toEqual(first.data.drives);
      expect(again.data.events).toEqual(first.data.events);
      expect(again.data.events.find((e) => e.type === 'drive-removed')!.payload).toMatchObject({
        removedOn: daysAgo(5),
      });
    } finally {
      fresh.sqlite.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('R69, R14: POST /api/drives/:id/remove takes removedOn; omitted body is today; bad input is a 400', async () => {
    const [s1, s2, s3] = slotIds();
    const a = spare('A');
    const b = spare('B');
    const c = spare('C');
    assignDrive(db(), { driveId: a.id, slotId: s1!, installedOn: daysAgo(60) });
    assignDrive(db(), { driveId: b.id, slotId: s2!, installedOn: daysAgo(60) });
    assignDrive(db(), { driveId: c.id, slotId: s3!, installedOn: daysAgo(60) });
    const post = (id: string, payload?: object) =>
      app.inject({ method: 'POST', url: `/api/drives/${id}/remove`, payload });

    const dated = await post(a.id, { removedOn: daysAgo(7) });
    expect(dated.statusCode).toBe(200);
    expect(dated.json()).toMatchObject({ status: 'spare' });
    expect(event(a.id, 'drive-removed').payload).toMatchObject({ removedOn: daysAgo(7) });

    const none = await post(b.id);
    expect(none.statusCode).toBe(200);
    expect(event(b.id, 'drive-removed').payload).toMatchObject({ removedOn: TODAY() });

    expect((await post(c.id, { removedOn: 'last tuesday' })).statusCode).toBe(400);
    expect((await post(c.id, { removedOn: daysAgo(-4) })).statusCode).toBe(400);
    expect((await post(c.id, { removedOn: '2026-10-01', bogus: 1 })).statusCode).toBe(400);
    expect(getDrive(db(), c.id).status).toBe('installed');
  });
});
