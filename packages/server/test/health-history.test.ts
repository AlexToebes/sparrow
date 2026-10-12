import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Health, Observation } from '@sparrow/shared';
import { retireDrive } from '../src/core/assignment.js';
import { createDrive, getDrive } from '../src/core/drives.js';
import { recordHealthChanges } from '../src/core/health-history.js';
import { createPoller } from '../src/core/poller.js';
import type { DriveDataProvider } from '../src/core/provider-port.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories } from '../src/db/repositories.js';
import { events } from '../src/db/schema.js';
import { activitiesOf, eventsOfDrive as listDriveEvents } from './activity-helpers.js';

let opened: OpenedDatabase;
beforeEach(() => {
  opened = openDatabase(':memory:');
});
afterEach(() => opened.sqlite.close());
const db = () => opened.db;

const obs = (serial: string, health: Health, extra: Partial<Observation> = {}): Observation => ({
  serial,
  health,
  lastReportedAt: '2026-03-04T05:06:07.000Z',
  state: 'active',
  ...extra,
});
const T1 = '2026-03-05T00:00:00.000Z';
const T2 = '2026-03-06T00:00:00.000Z';
const healthEvents = (driveId: string) =>
  listDriveEvents(db(), driveId).filter((e) => e.type === 'health-changed');
const allHealthEvents = () =>
  db()
    .select()
    .from(events)
    .all()
    .filter((e) => e.type === 'health-changed');

describe('R20 health changes in the event log', () => {
  it('R20: the first report is logged with from null, at the poll time', () => {
    const d = createDrive(db(), { serial: 'AAA' });
    expect(recordHealthChanges(db(), [obs('AAA', 'ok')], T1)).toBe(1);
    const [e] = healthEvents(d.id);
    expect(e).toMatchObject({
      type: 'health-changed',
      payload: { from: null, to: 'ok', reportedAt: '2026-03-04T05:06:07.000Z' },
    });
    // The activity is the poll: recorded at the poll time, no user date.
    const poll = activitiesOf(db()).find((a) => a.kind === 'health-polled')!;
    expect(poll).toMatchObject({ recordedAt: T1, occurredOn: null });
  });

  it('R20, R14: one poll is ONE health-polled activity with a health-changed event per changed drive; none if nothing changed', () => {
    createDrive(db(), { serial: 'AAA' });
    createDrive(db(), { serial: 'BBB' });
    recordHealthChanges(db(), [obs('AAA', 'ok'), obs('BBB', 'ok')], T1);
    recordHealthChanges(db(), [obs('AAA', 'ok'), obs('BBB', 'ok')], T2); // nothing changed
    recordHealthChanges(db(), [obs('AAA', 'ok'), obs('BBB', 'failed')], T2);
    const polls = activitiesOf(db()).filter((a) => a.kind === 'health-polled');
    expect(polls.map((a) => a.events.length)).toEqual([2, 1]);
    expect(polls.map((a) => a.recordedAt)).toEqual([T1, T2]);
  });

  it('R20: a change is logged with from, to and the reported time', () => {
    const d = createDrive(db(), { serial: 'AAA' });
    recordHealthChanges(db(), [obs('AAA', 'ok')], T1);
    const reported = '2026-03-06T00:00:00.000Z';
    recordHealthChanges(db(), [obs('AAA', 'warning', { lastReportedAt: reported })], T2);
    const [latest, first] = healthEvents(d.id);
    expect(first!.payload).toMatchObject({ from: null, to: 'ok' });
    expect(latest).toMatchObject({
      payload: { from: 'ok', to: 'warning', reportedAt: reported },
    });
    expect(activitiesOf(db()).filter((a) => a.kind === 'health-polled')[1]!.recordedAt).toBe(T2);
    expect(Object.keys(latest!.payload).sort()).toEqual(['from', 'reportedAt', 'to']);
  });

  it('R20: no change writes no event', () => {
    const d = createDrive(db(), { serial: 'AAA' });
    recordHealthChanges(db(), [obs('AAA', 'ok')], T1);
    expect(recordHealthChanges(db(), [obs('AAA', 'ok', { lastReportedAt: T2 })], T2)).toBe(0);
    expect(healthEvents(d.id)).toHaveLength(1);
  });

  it('R20: several drives in one poll each get their own event; unmatched ones are skipped', () => {
    const a = createDrive(db(), { serial: 'AAA' });
    const b = createDrive(db(), { serial: 'BBB' });
    recordHealthChanges(db(), [obs('AAA', 'ok'), obs('bbb', 'failed'), obs('ZZZ', 'ok')], T1);
    expect(healthEvents(a.id)[0]!.payload).toMatchObject({ from: null, to: 'ok' });
    expect(healthEvents(b.id)[0]!.payload).toMatchObject({ from: null, to: 'failed' });
    expect(allHealthEvents()).toHaveLength(2);
  });

  it('R20: unknown is a health value like any other', () => {
    const d = createDrive(db(), { serial: 'AAA' });
    recordHealthChanges(db(), [obs('AAA', 'ok')], T1);
    recordHealthChanges(db(), [obs('AAA', 'unknown')], T2);
    expect(healthEvents(d.id)[0]!.payload).toMatchObject({ from: 'ok', to: 'unknown' });
  });

  it('R20, R63: decommissioned observations are not health reports', () => {
    const d = createDrive(db(), { serial: 'AAA' });
    const decommissioned = obs('AAA', 'failed', { state: 'decommissioned' });
    expect(recordHealthChanges(db(), [decommissioned], T1)).toBe(0);
    expect(healthEvents(d.id)).toHaveLength(0);
  });

  it('R20, R10: a matched retired drive gets events but its status is untouched', () => {
    const d = createDrive(db(), { serial: 'AAA' });
    retireDrive(db(), d.id, { reason: 'failed' });
    recordHealthChanges(db(), [obs('AAA', 'failed')], T1);
    expect(healthEvents(d.id)).toHaveLength(1);
    expect(getDrive(db(), d.id).status).toBe('retired');
  });

  it('R20, R10: a matched spare gets an event and stays a spare', () => {
    const d = createDrive(db(), { serial: 'AAA' });
    recordHealthChanges(db(), [obs('AAA', 'warning')], T1);
    expect(healthEvents(d.id)).toHaveLength(1);
    expect(getDrive(db(), d.id).status).toBe('spare');
  });

  it('R20, R14: all writes of one poll are one transaction', () => {
    createDrive(db(), { serial: 'AAA' });
    createDrive(db(), { serial: 'BBB' });
    opened.sqlite.exec(`CREATE TRIGGER boom BEFORE INSERT ON events
      WHEN NEW.type = 'health-changed' AND (SELECT count(*) FROM events WHERE type = 'health-changed') >= 1
      BEGIN SELECT RAISE(ABORT, 'boom'); END`);
    expect(() => recordHealthChanges(db(), [obs('AAA', 'ok'), obs('BBB', 'ok')], T1)).toThrow();
    expect(allHealthEvents()).toHaveLength(0);
  });
});

describe('R20 through the poller', () => {
  const fake = (id: string, impl: () => Promise<unknown>): DriveDataProvider => ({
    id,
    capabilities: { drives: true, pools: false },
    expectedUpdateIntervalHours: 1,
    fetchSnapshot: impl as () => Promise<Observation[]>,
    checkConnection: async () => ({ ok: true }),
  });

  it('R20: a successful poll logs, a failed poll writes nothing', async () => {
    const d = createDrive(db(), { serial: 'AAA' });
    let fail = false;
    const p = createPoller({
      db: db(),
      provider: fake('fake', async () => {
        if (fail) throw new Error('boom');
        return [obs('AAA', 'ok')];
      }),
      intervalMs: 1000,
      now: () => new Date(T1),
    });
    await p.pollOnce();
    expect(healthEvents(d.id)).toHaveLength(1);
    fail = true;
    await p.pollOnce();
    expect(healthEvents(d.id)).toHaveLength(1);
  });

  it('R20, R55: a failing poll with a cache from another provider writes nothing', async () => {
    const d = createDrive(db(), { serial: 'AAA' });
    createRepositories(db()).snapshot.put({
      providerId: 'old',
      observations: [obs('AAA', 'failed')],
      lastSuccessAt: T1,
      lastAttemptAt: T1,
    });
    const p = createPoller({
      db: db(),
      provider: fake('fake', async () => {
        throw new Error('down');
      }),
      intervalMs: 1000,
      now: () => new Date(T2),
    });
    expect(await p.pollOnce()).toMatchObject({ ok: false });
    expect(healthEvents(d.id)).toHaveLength(0);
  });
});
