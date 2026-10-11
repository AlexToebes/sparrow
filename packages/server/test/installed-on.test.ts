import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import type { Observation } from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { assignDrive, removeToSpares, retireDrive, sendForRma } from '../src/core/assignment.js';
import { exportData, importData } from '../src/core/backup.js';
import { createDrive, getDrive, updateDrive } from '../src/core/drives.js';
import { DomainError } from '../src/core/errors.js';
import { listDriveEvents } from '../src/core/events.js';
import { createLayoutService } from '../src/core/layout.js';
import { parseInstalledOn } from '../src/core/installed-on.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories } from '../src/db/repositories.js';
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

describe('R68: installation date when assigning', () => {
  it('R68: a past date is stored on the drive; the event is stamped now and carries installedOn', () => {
    const [slot] = slotIds();
    const d = spare('A');
    const date = daysAgo(400);
    const before = Date.now();
    const out = assignDrive(db(), { driveId: d.id, slotId: slot!, installedOn: date });
    expect(out.drive.installedOn).toBe(date);
    expect(getDrive(db(), d.id).installedOn).toBe(date);
    const installed = event(d.id, 'drive-installed');
    expect(installed.payload).toMatchObject({ installedOn: date });
    expect(Date.parse(installed.at)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('R68: without installedOn it defaults to today (UTC)', () => {
    const [slot] = slotIds();
    const d = spare('A');
    expect(assignDrive(db(), { driveId: d.id, slotId: slot! }).drive.installedOn).toBe(TODAY());
  });

  it('R68, R14: installedOn null stores "not recorded"; the event says so and the membership starts now', () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    const out = assignDrive(db(), {
      driveId: d.id,
      slotId: slot!,
      poolId: pool,
      installedOn: null,
    });
    expect(out.drive.installedOn).toBeNull();
    expect(out.drive.status).toBe('installed');
    expect(event(d.id, 'drive-installed').payload).toMatchObject({ installedOn: null });
    const joined = event(d.id, 'pool-joined');
    expect(members(d.id)[0]!.startedAt).toBe(joined.at);
    expect(joined.payload).not.toHaveProperty('startedAt');
  });

  it('R68: the database allows an installed drive without an installation date, but a spare keeps none', () => {
    const [slot] = slotIds();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, installedOn: null });
    expect(() =>
      opened.sqlite
        .prepare(
          "UPDATE drives SET status = 'spare', slot_id = NULL, installed_on = '2025-01-01' WHERE id = ?",
        )
        .run(d.id),
    ).toThrow(/CHECK/);
  });

  it('R29, R68: the pool membership starts at midnight UTC of a past date; pool-joined is stamped now', () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    const date = daysAgo(30);
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: pool, installedOn: date });
    expect(members(d.id)[0]!.startedAt).toBe(`${date}T00:00:00.000Z`);
    const joined = event(d.id, 'pool-joined');
    expect(joined.payload).toMatchObject({ startedAt: `${date}T00:00:00.000Z` });
    expect(joined.at.slice(0, 10)).toBe(TODAY());
  });

  it('R29, R68: installing today keeps the membership start equal to the event time', () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: pool, installedOn: TODAY() });
    const joined = event(d.id, 'pool-joined');
    expect(members(d.id)[0]!.startedAt).toBe(joined.at);
    expect(joined.payload).not.toHaveProperty('startedAt');
  });

  it('R68: a future date is rejected (400) and nothing changes', () => {
    const [slot] = slotIds();
    const d = spare('A');
    const err = thrown(() =>
      assignDrive(db(), { driveId: d.id, slotId: slot!, installedOn: daysAgo(-3) }),
    );
    expect(err.code).toBe('invalid');
    expect(getDrive(db(), d.id).status).toBe('spare');
  });

  it('R68: parseInstalledOn allows today in any timezone (UTC + 1 day) but not beyond', () => {
    const now = new Date('2026-10-11T12:00:00.000Z');
    expect(parseInstalledOn('2026-10-12', now)).toBe('2026-10-12');
    expect(thrown(() => parseInstalledOn('2026-10-13', now)).code).toBe('invalid');
    expect(thrown(() => parseInstalledOn('2026-02-30', now)).code).toBe('invalid');
    expect(thrown(() => parseInstalledOn('11/10/2026', now)).code).toBe('invalid');
  });

  it('R68: POST /api/slots/:id/assign takes installedOn; a malformed or future one is a 400', async () => {
    const [slot] = slotIds();
    const d = spare('A');
    const post = (payload: object) =>
      app.inject({ method: 'POST', url: `/api/slots/${slot}/assign`, payload });
    expect((await post({ driveId: d.id, installedOn: 'yesterday' })).statusCode).toBe(400);
    expect((await post({ driveId: d.id, installedOn: daysAgo(-5) })).statusCode).toBe(400);
    const ok = await post({ driveId: d.id, installedOn: '2025-03-04' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ drive: { installedOn: '2025-03-04' } });
  });

  it('R68: over the API, an omitted installedOn on assign is today and an explicit null is not recorded', async () => {
    const [s1, s2] = slotIds();
    const a = spare('A');
    const b = spare('B');
    const post = (slot: string | undefined, payload: object) =>
      app.inject({ method: 'POST', url: `/api/slots/${slot}/assign`, payload });
    expect((await post(s1, { driveId: a.id })).json()).toMatchObject({
      drive: { installedOn: TODAY() },
    });
    expect((await post(s2, { driveId: b.id, installedOn: null })).json()).toMatchObject({
      drive: { status: 'installed', installedOn: null },
    });
  });
});

describe('R68: editing the installation date', () => {
  it('R14, R68: PATCH changes it, logs drive-updated with from/to and moves a matching membership start', async () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: pool });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/drives/${d.id}`,
      payload: { installedOn: '2024-06-01' },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ installedOn: '2024-06-01' });
    const updated = event(d.id, 'drive-updated');
    expect(updated.payload).toMatchObject({
      changes: { installedOn: { from: TODAY(), to: '2024-06-01' } },
      membershipStartedAt: { to: '2024-06-01T00:00:00.000Z' },
    });
    expect(members(d.id)[0]!.startedAt).toBe('2024-06-01T00:00:00.000Z');
  });

  it('R29, R68: a membership that was started on another date is left alone', () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: pool, installedOn: '2025-01-01' });
    db()
      .update(memberships)
      .set({ startedAt: '2025-02-02T00:00:00.000Z' })
      .where(eq(memberships.driveId, d.id))
      .run();
    updateDrive(db(), d.id, { installedOn: '2024-12-24' });
    expect(members(d.id)[0]!.startedAt).toBe('2025-02-02T00:00:00.000Z');
    expect(event(d.id, 'drive-updated').payload).not.toHaveProperty('membershipStartedAt');
  });

  it('R68: the same date is a no-op without an event', () => {
    const [slot] = slotIds();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, installedOn: '2025-01-01' });
    const before = listDriveEvents(db(), d.id).length;
    updateDrive(db(), d.id, { installedOn: '2025-01-01' });
    expect(listDriveEvents(db(), d.id)).toHaveLength(before);
  });

  it('R68: a future or malformed date is rejected (400) and nothing changes', async () => {
    const [slot] = slotIds();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot! });
    const patch = (payload: object) =>
      app.inject({ method: 'PATCH', url: `/api/drives/${d.id}`, payload });
    expect((await patch({ installedOn: daysAgo(-9) })).statusCode).toBe(400);
    expect((await patch({ installedOn: 'soon' })).statusCode).toBe(400);
    expect(getDrive(db(), d.id).installedOn).toBe(TODAY());
  });

  it('R14, R68: PATCH null clears the date (drive-updated from/to) and leaves the membership alone', async () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: pool, installedOn: '2025-01-01' });
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/drives/${d.id}`,
      payload: { installedOn: null },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ status: 'installed', installedOn: null });
    const updated = event(d.id, 'drive-updated');
    expect(updated.payload).toMatchObject({
      changes: { installedOn: { from: '2025-01-01', to: null } },
    });
    expect(updated.payload).not.toHaveProperty('membershipStartedAt');
    expect(members(d.id)[0]!.startedAt).toBe('2025-01-01T00:00:00.000Z');
  });

  it('R14, R68: PATCH sets a date on a drive with no recorded date, leaving the membership alone', () => {
    const [slot] = slotIds();
    const pool = makePool();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, poolId: pool, installedOn: null });
    const started = members(d.id)[0]!.startedAt;
    updateDrive(db(), d.id, { installedOn: '2024-03-03' });
    expect(getDrive(db(), d.id).installedOn).toBe('2024-03-03');
    expect(event(d.id, 'drive-updated').payload).toMatchObject({
      changes: { installedOn: { from: null, to: '2024-03-03' } },
    });
    expect(members(d.id)[0]!.startedAt).toBe(started);
  });

  it('R68: clearing an already-unrecorded date is a no-op without an event', () => {
    const [slot] = slotIds();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, installedOn: null });
    const before = listDriveEvents(db(), d.id).length;
    updateDrive(db(), d.id, { installedOn: null });
    expect(listDriveEvents(db(), d.id)).toHaveLength(before);
  });

  it('R68: a spare or a retired drive cannot be given an installation date (409)', async () => {
    slotIds();
    const a = spare('A');
    const b = spare('B');
    retireDrive(db(), b.id, { reason: 'other' });
    for (const id of [a.id, b.id]) {
      const res = await app.inject({
        method: 'PATCH',
        url: `/api/drives/${id}`,
        payload: { installedOn: '2025-01-01' },
      });
      expect(res.statusCode).toBe(409);
    }
    expect(getDrive(db(), a.id).installedOn).toBeNull();
  });
});

describe('R68: leaving the slot clears the date, the history keeps it', () => {
  it('R14: removal clears installedOn and drive-removed carries it', () => {
    const [slot] = slotIds();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, installedOn: '2025-05-05' });
    expect(removeToSpares(db(), d.id).installedOn).toBeNull();
    expect(event(d.id, 'drive-removed').payload).toMatchObject({ installedOn: '2025-05-05' });
  });

  it('R60, R27: retiring or sending for RMA an installed drive clears it and keeps it on the retire / RMA event', () => {
    const [s1, s2] = slotIds();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: s1!, installedOn: '2025-05-05' });
    assignDrive(db(), { driveId: b.id, slotId: s2!, installedOn: '2025-06-06' });
    expect(retireDrive(db(), a.id, { reason: 'failed' }).installedOn).toBeNull();
    expect(sendForRma(db(), b.id, {}).installedOn).toBeNull();
    expect(event(a.id, 'drive-retired').payload).toMatchObject({ installedOn: '2025-05-05' });
    expect(event(b.id, 'drive-sent-for-rma').payload).toMatchObject({ installedOn: '2025-06-06' });
  });

  it('R14, R68: removing a drive with no recorded date logs installedOn null', () => {
    const [slot] = slotIds();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, installedOn: null });
    expect(removeToSpares(db(), d.id).installedOn).toBeNull();
    expect(event(d.id, 'drive-removed').payload).toMatchObject({ installedOn: null });
  });

  it('R37, R68: resolving an occupant keeps its date in drive-replaced; the newcomer gets its own', () => {
    const [slot] = slotIds();
    const a = spare('A');
    const b = spare('B');
    assignDrive(db(), { driveId: a.id, slotId: slot!, installedOn: '2024-01-01' });
    assignDrive(db(), {
      driveId: b.id,
      slotId: slot!,
      installedOn: '2025-02-02',
      occupant: { action: 'spare' },
    });
    expect(getDrive(db(), a.id).installedOn).toBeNull();
    expect(getDrive(db(), b.id).installedOn).toBe('2025-02-02');
    expect(event(a.id, 'drive-replaced').payload).toMatchObject({
      installedOn: '2025-02-02',
      outgoing: { installedOn: '2024-01-01' },
    });
  });
});

describe('R22, R23, R68: inbox flows pass installedOn through', () => {
  const obs = (serial: string): Observation => ({
    serial,
    health: 'ok',
    lastReportedAt: '2026-03-04T05:06:07.000Z',
    state: 'active',
  });
  const snapshot = (observations: Observation[]) =>
    createRepositories(db()).snapshot.put({
      providerId: 'fake',
      observations,
      lastSuccessAt: '2026-03-04T05:06:07.000Z',
      lastAttemptAt: '2026-03-04T05:06:07.000Z',
    });

  it('R22: link and create-from-observation install with the given date (first run: long ago)', async () => {
    const [s1, s2, s3] = slotIds();
    const shelf = spare('SHELF');
    snapshot([obs('SHELF'), obs('NEWONE'), obs('THIRD')]);
    const link = await app.inject({
      method: 'POST',
      url: '/api/inbox/SHELF/link',
      payload: { driveId: shelf.id, slotId: s1, installedOn: '2023-04-05' },
    });
    expect(link.statusCode).toBe(200);
    expect(getDrive(db(), shelf.id).installedOn).toBe('2023-04-05');
    const create = await app.inject({
      method: 'POST',
      url: '/api/inbox/NEWONE/create',
      payload: { slotId: s2, installedOn: '2021-01-02' },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({ drive: { installedOn: '2021-01-02' } });
    const bad = await app.inject({
      method: 'POST',
      url: '/api/inbox/THIRD/create',
      payload: { slotId: s3, installedOn: daysAgo(-9) },
    });
    expect(bad.statusCode).toBe(400);
  });

  it('R22, R68: link and create default to "not recorded" when installedOn is omitted; an explicit date is kept', async () => {
    const [s1, s2, s3] = slotIds();
    const shelf = spare('SHELF');
    snapshot([obs('SHELF'), obs('NEWONE'), obs('THIRD')]);
    const link = await app.inject({
      method: 'POST',
      url: '/api/inbox/SHELF/link',
      payload: { driveId: shelf.id, slotId: s1 },
    });
    expect(link.statusCode).toBe(200);
    expect(getDrive(db(), shelf.id)).toMatchObject({ status: 'installed', installedOn: null });
    expect(event(shelf.id, 'drive-installed').payload).toMatchObject({ installedOn: null });
    const create = await app.inject({
      method: 'POST',
      url: '/api/inbox/NEWONE/create',
      payload: { slotId: s2 },
    });
    expect(create.statusCode).toBe(201);
    expect(create.json()).toMatchObject({ drive: { status: 'installed', installedOn: null } });
    const explicit = await app.inject({
      method: 'POST',
      url: '/api/inbox/THIRD/create',
      payload: { slotId: s3, installedOn: null },
    });
    expect(explicit.json()).toMatchObject({ drive: { installedOn: null } });
  });
});

describe('R41, R43, R68: export and import', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'sparrow-inst-'));
  });
  afterEach(() => rmSync(tmp, { recursive: true, force: true }));

  it('R43: installedOn survives an export, import and export round trip', () => {
    const [slot] = slotIds();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, installedOn: '2022-02-02' });
    const first = exportData(db());
    expect(first.data.drives[0]!.installedOn).toBe('2022-02-02');
    const fresh = openDatabase(':memory:');
    try {
      importData(fresh.db, JSON.parse(JSON.stringify(first)), { backupDir: tmp });
      expect(exportData(fresh.db).data.drives).toEqual(first.data.drives);
    } finally {
      fresh.sqlite.close();
    }
  });

  it('R43, R68: installedOn null for an installed drive is valid and survives a round trip', () => {
    const [slot] = slotIds();
    const d = spare('A');
    assignDrive(db(), { driveId: d.id, slotId: slot!, installedOn: null });
    const first = exportData(db());
    expect(first.data.drives[0]).toMatchObject({ status: 'installed', installedOn: null });
    const fresh = openDatabase(':memory:');
    try {
      importData(fresh.db, JSON.parse(JSON.stringify(first)), { backupDir: tmp });
      expect(exportData(fresh.db).data.drives).toEqual(first.data.drives);
    } finally {
      fresh.sqlite.close();
    }
  });
});
