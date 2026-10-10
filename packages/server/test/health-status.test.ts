import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Observation } from '@sparrow/shared';
import { assignDrive, removeToSpares, retireDrive, sendForRma } from '../src/core/assignment.js';
import { computeSlotStatus, type SlotStatusResult } from '../src/core/health-status.js';
import { createDrive, listDrives } from '../src/core/drives.js';
import { listDriveEvents } from '../src/core/events.js';
import { createLayoutService } from '../src/core/layout.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories } from '../src/db/repositories.js';
import { events } from '../src/db/schema.js';

// Stale and missing detection (R10, R27, R28, R47). Everything runs against a fixed `now`, and the
// tests check that computing the status never changes drives or events.

let opened: OpenedDatabase;
beforeEach(() => {
  opened = openDatabase(':memory:');
});
afterEach(() => opened.sqlite.close());
const db = () => opened.db;

const NOW = new Date('2026-10-10T12:00:00.000Z');
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(NOW.getTime() - hours * HOUR).toISOString();
const PROVIDER = 'fake';
const DEFAULT_THRESHOLD = 1.5 * 24; // 36 h, from a 24 h provider interval (R28)

function slots(): string[] {
  const layout = createLayoutService(db());
  const enclosure = layout.createEnclosure({ name: 'NAS' });
  layout.createGrid(enclosure.id, { name: 'Front', rows: 2, columns: 3, orientation: 'landscape' });
  return layout
    .getLayout()
    .enclosures.flatMap((e) => e.grids.flatMap((g) => g.slots.map((s) => s.id)));
}

function install(serial: string, slotId: string): string {
  const drive = createDrive(db(), { serial });
  assignDrive(db(), { driveId: drive.id, slotId });
  return drive.id;
}

const obs = (serial: string, extra: Partial<Observation> = {}): Observation => ({
  serial,
  health: 'ok',
  lastReportedAt: ago(1),
  state: 'active',
  ...extra,
});

function snapshot(
  observations: Observation[],
  overrides: { providerId?: string; lastSuccessAt?: string | null } = {},
) {
  const at = overrides.lastSuccessAt === undefined ? NOW.toISOString() : overrides.lastSuccessAt;
  createRepositories(db()).snapshot.put({
    providerId: overrides.providerId ?? PROVIDER,
    observations,
    lastSuccessAt: at,
    lastAttemptAt: at,
    lastError: null,
  });
}

const status = (extra: { staleAfterHours?: number; providerId?: string } = {}) =>
  computeSlotStatus(db(), {
    now: NOW,
    staleAfterHours: extra.staleAfterHours ?? DEFAULT_THRESHOLD,
    providerId: extra.providerId ?? PROVIDER,
  });

const slotOf = (result: SlotStatusResult, slotId: string) =>
  result.slots.find((s) => s.slotId === slotId);

/** Everything a status read must leave alone: all drives and all events. */
const dataSnapshot = () => ({
  drives: listDrives(db()),
  events: db().select().from(events).all(),
});

describe('R10: decommissioned observation flags its slot', () => {
  it('flags the slot as decommissioned and keeps the last known health', () => {
    const [a, b] = slots();
    const driveA = install('A', a!);
    install('B', b!);
    snapshot([obs('A', { state: 'decommissioned', health: 'failed' }), obs('B')]);

    const result = status();
    const slotA = slotOf(result, a!);
    expect(slotA).toMatchObject({
      driveId: driveA,
      health: 'failed',
      stale: false,
      flag: { kind: 'missing', reason: 'decommissioned' },
    });
    expect(slotOf(result, b!)).toMatchObject({ health: 'ok', stale: false, flag: null });
    expect(result.providerStale).toBe(false);
  });
});

describe('R10: stale observation flags its slot while another drive is fresh', () => {
  it('flags only the stale slot and still reports its health', () => {
    const [a, b] = slots();
    install('A', a!);
    install('B', b!);
    snapshot([
      obs('A', { lastReportedAt: ago(2) }),
      obs('B', { lastReportedAt: ago(40), health: 'warning' }),
    ]);

    const result = status();
    expect(slotOf(result, b!)).toMatchObject({
      health: 'warning',
      lastReportedAt: ago(40),
      stale: true,
      flag: { kind: 'missing', reason: 'stale' },
    });
    expect(slotOf(result, a!)).toMatchObject({ stale: false, flag: null });
    expect(result.providerStale).toBe(false);
  });
});

describe('R10: a drive that vanished from the provider is flagged as not reported', () => {
  it('flags an installed drive with no observation while the provider has fresh data', () => {
    const [a, b] = slots();
    install('A', a!);
    install('GONE', b!);
    snapshot([obs('A')]);

    expect(slotOf(status(), b!)).toMatchObject({
      health: 'unknown',
      lastReportedAt: null,
      temperatureC: null,
      detailUrl: null,
      stale: false,
      flag: { kind: 'missing', reason: 'not-reported' },
    });
  });
});

describe('R28: stale threshold', () => {
  it('defaults to 1.5 x the provider interval, so 36 h for a 24 h provider', () => {
    const [a, b] = slots();
    install('A', a!);
    install('B', b!);
    snapshot([
      obs('A'),
      obs('B', { lastReportedAt: ago(36) }), // exactly at the threshold: still fresh
    ]);
    expect(slotOf(status(), b!)).toMatchObject({ stale: false, flag: null });

    snapshot([obs('A'), obs('B', { lastReportedAt: ago(36.01) })]);
    expect(slotOf(status(), b!)).toMatchObject({ stale: true, flag: { reason: 'stale' } });
  });

  it('uses the override when given', () => {
    const [a, b] = slots();
    install('A', a!);
    install('B', b!);
    snapshot([obs('A', { lastReportedAt: ago(0.5) }), obs('B', { lastReportedAt: ago(3) })]);

    expect(slotOf(status({ staleAfterHours: 2 }), b!)).toMatchObject({
      stale: true,
      flag: { reason: 'stale' },
    });
    expect(slotOf(status(), b!)).toMatchObject({ stale: false, flag: null });
  });
});

describe('R47: every tracked drive stale means a provider-level banner, not slot flags', () => {
  it('sets providerStale, raises no flags, and still marks each slot stale', () => {
    const [a, b] = slots();
    install('A', a!);
    install('B', b!);
    snapshot([
      obs('A', { lastReportedAt: ago(50) }),
      obs('B', { lastReportedAt: ago(60), health: 'warning' }),
    ]);

    const result = status();
    expect(result.providerStale).toBe(true);
    expect(result.lastSuccessAt).toBe(NOW.toISOString());
    expect(result.slots).toHaveLength(2);
    for (const slot of result.slots) expect(slot).toMatchObject({ stale: true, flag: null });
    expect(slotOf(result, b!)).toMatchObject({ health: 'warning' });
  });

  it('is also raised when the last successful poll itself is older than the threshold', () => {
    const [a] = slots();
    install('A', a!);
    snapshot([obs('A', { lastReportedAt: ago(50) })], { lastSuccessAt: ago(50) });

    const result = status();
    expect(result.providerStale).toBe(true);
    expect(result.lastSuccessAt).toBe(ago(50));
    expect(slotOf(result, a!)).toMatchObject({ stale: true, flag: null });
  });

  it('does not suppress a decommissioned flag when at least one tracked drive is fresh', () => {
    const [a, b] = slots();
    install('A', a!);
    install('B', b!);
    snapshot([
      obs('A', { state: 'decommissioned', health: 'failed' }),
      obs('B', { lastReportedAt: ago(1) }),
    ]);

    expect(status().providerStale).toBe(false);
    expect(slotOf(status(), a!)?.flag).toEqual({ kind: 'missing', reason: 'decommissioned' });
  });
});

describe('provider none and missing data', () => {
  it('reports every installed slot as unknown with no flags when the provider is none', () => {
    const [a, b] = slots();
    install('A', a!);
    install('B', b!);
    snapshot([obs('A', { state: 'decommissioned', health: 'failed' })], { providerId: 'none' });

    const result = status({ providerId: 'none' });
    expect(result.providerStale).toBe(false);
    expect(result.lastSuccessAt).toBeNull();
    expect(result.slots.map((s) => [s.health, s.flag, s.stale])).toEqual([
      ['unknown', null, false],
      ['unknown', null, false],
    ]);
  });

  it('reports unknown with no flags before any successful snapshot', () => {
    const [a] = slots();
    install('A', a!);
    expect(status().slots).toEqual([
      {
        slotId: a,
        driveId: expect.any(String),
        health: 'unknown',
        lastReportedAt: null,
        temperatureC: null,
        detailUrl: null,
        stale: false,
        flag: null,
      },
    ]);
    snapshot([obs('A')], { lastSuccessAt: null });
    expect(status().slots[0]).toMatchObject({ health: 'unknown', flag: null });
  });

  it('ignores a cached snapshot written by a different provider', () => {
    const [a] = slots();
    install('A', a!);
    snapshot([obs('A', { state: 'decommissioned', health: 'failed' })], { providerId: 'other' });

    const result = status();
    expect(result.slots[0]).toMatchObject({ health: 'unknown', flag: null });
    expect(result.providerStale).toBe(false);
  });

  it('lists only installed drives: spares, retired drives and empty slots are omitted', () => {
    const [a, b] = slots();
    install('A', a!);
    createDrive(db(), { serial: 'SPARE' });
    const retired = createDrive(db(), { serial: 'OLD' });
    retireDrive(db(), retired.id, { reason: 'failed' });
    snapshot([obs('A'), obs('SPARE'), obs('OLD', { state: 'decommissioned' })]);

    const result = status();
    expect(result.slots.map((s) => s.slotId)).toEqual([a]);
    expect(slotOf(result, b!)).toBeUndefined();
  });

  it('matches observations by normalized serial', () => {
    const [a] = slots();
    install('ab12cd', a!);
    snapshot([obs('  AB12CD ', { health: 'warning' })]);

    expect(status().slots[0]).toMatchObject({ health: 'warning', flag: null });
  });
});

describe('R10, R27: computing status never changes data', () => {
  it('leaves drives and events untouched, however often it is read', () => {
    const [a, b, c] = slots();
    install('A', a!);
    install('B', b!);
    install('GONE', c!);
    snapshot([
      obs('A', { state: 'decommissioned', health: 'failed' }),
      obs('B', { lastReportedAt: ago(40) }),
    ]);

    const before = dataSnapshot();
    const first = status();
    for (let i = 0; i < 3; i++) expect(status()).toEqual(first);
    expect(dataSnapshot()).toEqual(before);
    expect(first.slots.filter((s) => s.flag !== null)).toHaveLength(3);
    expect(listDrives(db(), { status: 'installed' })).toHaveLength(3);
  });
});

describe('R27: the three missing-drive outcomes clear the flag and log the outcome', () => {
  function flaggedSlot() {
    const [a, b] = slots();
    const driveA = install('A', a!);
    install('B', b!);
    snapshot([obs('A', { state: 'decommissioned', health: 'failed' }), obs('B')]);
    expect(slotOf(status(), a!)?.flag).toEqual({ kind: 'missing', reason: 'decommissioned' });
    return { slot: a!, driveId: driveA };
  }

  it('back to spares: slot is freed, drive-removed is logged', () => {
    const { slot, driveId } = flaggedSlot();
    removeToSpares(db(), driveId);

    expect(slotOf(status(), slot)).toBeUndefined();
    expect(listDrives(db(), { status: 'spare' }).map((d) => d.id)).toContain(driveId);
    expect(listDriveEvents(db(), driveId).map((e) => e.type)).toEqual([
      'drive-removed',
      'drive-installed',
      'drive-created',
    ]);
  });

  it('retired: slot is freed, drive-retired with the reason is logged', () => {
    const { slot, driveId } = flaggedSlot();
    retireDrive(db(), driveId, { reason: 'failed', date: '2026-10-10' });

    expect(slotOf(status(), slot)).toBeUndefined();
    const retired = listDriveEvents(db(), driveId)[0]!;
    expect(retired.type).toBe('drive-retired');
    expect(retired.payload).toMatchObject({ reason: 'failed', date: '2026-10-10', slotId: slot });
  });

  it('sent for RMA: retired as failed, then drive-sent-for-rma is logged', () => {
    const { slot, driveId } = flaggedSlot();
    sendForRma(db(), driveId, { date: '2026-10-10', note: 'RMA #42' });

    expect(slotOf(status(), slot)).toBeUndefined();
    const log = listDriveEvents(db(), driveId);
    expect(log.map((e) => e.type)).toEqual([
      'drive-sent-for-rma',
      'drive-retired',
      'drive-removed',
      'drive-installed',
      'drive-created',
    ]);
    expect(log[1]!.payload).toMatchObject({ reason: 'failed', date: '2026-10-10' });
    expect(log[0]!.payload).toMatchObject({ date: '2026-10-10', note: 'RMA #42' });
  });
});
