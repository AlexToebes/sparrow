import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Observation } from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { loadConfig } from '../src/config.js';
import { assignDrive } from '../src/core/assignment.js';
import { createDrive } from '../src/core/drives.js';
import { createLayoutService } from '../src/core/layout.js';
import type { DriveDataProvider } from '../src/core/provider-port.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories } from '../src/db/repositories.js';

// GET /api/status and the stale threshold wiring (R28, R56, R47).

let opened: OpenedDatabase;
beforeEach(() => {
  opened = openDatabase(':memory:');
});
afterEach(() => opened.sqlite.close());
const db = () => opened.db;

const fake = (intervalHours: number): DriveDataProvider => ({
  id: 'fake',
  capabilities: { drives: true, pools: false },
  expectedUpdateIntervalHours: intervalHours,
  fetchSnapshot: async () => [],
  checkConnection: async () => ({ ok: true }),
});

const ago = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

function installOne(serial: string) {
  const layout = createLayoutService(db());
  const enclosure = layout.createEnclosure({ name: 'NAS' });
  layout.createGrid(enclosure.id, { name: 'Front', rows: 1, columns: 2, orientation: 'landscape' });
  const [slot] = layout
    .getLayout()
    .enclosures.flatMap((e) => e.grids.flatMap((g) => g.slots.map((s) => s.id)));
  const drive = createDrive(db(), { serial });
  assignDrive(db(), { driveId: drive.id, slotId: slot! });
  return drive;
}

function snapshot(observations: Observation[], providerId = 'fake') {
  const at = new Date().toISOString();
  createRepositories(db()).snapshot.put({
    providerId,
    observations,
    lastSuccessAt: at,
    lastAttemptAt: at,
    lastError: null,
  });
}

describe('GET /api/status', () => {
  it('returns the provider, the effective threshold and the slot status', async () => {
    installOne('A');
    snapshot([{ serial: 'A', health: 'ok', lastReportedAt: ago(1), state: 'active' }]);
    const app = buildApp({ db: db(), provider: fake(24) });

    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({
      providerId: 'fake',
      providerStale: false,
      staleAfterHours: 36,
      lastSuccessAt: expect.any(String),
    });
    expect(body.slots).toEqual([
      expect.objectContaining({ health: 'ok', stale: false, flag: null }),
    ]);
    await app.close();
  });

  it('uses STALE_AFTER_HOURS when the override is given (R28)', async () => {
    const app = buildApp({ db: db(), provider: fake(24), staleAfterHours: 2 });
    const res = await app.inject({ method: 'GET', url: '/api/status' });
    expect(res.json()).toMatchObject({ staleAfterHours: 2, providerId: 'fake' });
    await app.close();
  });

  it('reports provider none with no slot flags and no snapshot', async () => {
    installOne('A');
    const app = buildApp({ db: db() });
    const body = (await app.inject({ method: 'GET', url: '/api/status' })).json();
    expect(body).toMatchObject({
      providerId: 'none',
      providerStale: false,
      lastSuccessAt: null,
      staleAfterHours: 36,
    });
    expect(body.slots).toEqual([expect.objectContaining({ health: 'unknown', flag: null })]);
    await app.close();
  });
});

describe('STALE_AFTER_HOURS config (R28)', () => {
  it('is optional and unset by default', () => {
    expect(loadConfig({}).STALE_AFTER_HOURS).toBeUndefined();
    expect(loadConfig({ STALE_AFTER_HOURS: '' }).STALE_AFTER_HOURS).toBeUndefined();
  });

  it('parses a positive number of hours', () => {
    expect(loadConfig({ STALE_AFTER_HOURS: '12.5' }).STALE_AFTER_HOURS).toBe(12.5);
  });

  it('rejects zero, negative and non-numeric values', () => {
    expect(() => loadConfig({ STALE_AFTER_HOURS: '0' })).toThrow();
    expect(() => loadConfig({ STALE_AFTER_HOURS: '-3' })).toThrow();
    expect(() => loadConfig({ STALE_AFTER_HOURS: 'soon' })).toThrow();
  });
});
