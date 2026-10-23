import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ZodError } from 'zod';
import type { Observation } from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { assignDrive, retireDrive } from '../src/core/assignment.js';
import { createDrive, getDrive, listDrives } from '../src/core/drives.js';
import { DomainError } from '../src/core/errors.js';
import {
  createFromObservation,
  getInbox,
  importRetired,
  linkObservation,
  listRetiredCandidates,
} from '../src/core/inbox.js';
import { createLayoutService } from '../src/core/layout.js';
import { matchObservations } from '../src/core/matching.js';
import type { DriveDataProvider } from '../src/core/provider-port.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories } from '../src/db/repositories.js';
import { drives, events } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import { activitiesOf, eventsOfDrive, lastActivity, shape } from './activity-helpers.js';

const fakeProvider: DriveDataProvider = {
  id: 'fake',
  capabilities: { drives: true, pools: false },
  expectedUpdateIntervalHours: 1,
  fetchSnapshot: async () => [],
  checkConnection: async () => ({ ok: true }),
};

let opened: OpenedDatabase;
beforeEach(() => {
  opened = openDatabase(':memory:');
});
afterEach(() => opened.sqlite.close());
const db = () => opened.db;
const P = 'fake';

function slots(): string[] {
  const layout = createLayoutService(db());
  const enclosure = layout.createEnclosure({ name: 'NAS' });
  layout.createGrid(enclosure.id, { name: 'Front', rows: 2, columns: 2, orientation: 'landscape' });
  return layout
    .getLayout()
    .enclosures.flatMap((e) => e.grids.flatMap((g) => g.slots.map((s) => s.id)));
}

const obs = (serial: string | undefined, extra: Partial<Observation> = {}): Observation => ({
  ...(serial === undefined ? {} : { serial }),
  health: 'ok',
  lastReportedAt: '2026-03-04T05:06:07.000Z',
  state: 'active',
  ...extra,
});

function snapshot(observations: Observation[]) {
  createRepositories(db()).snapshot.put({
    providerId: 'fake',
    observations,
    lastSuccessAt: '2026-03-04T05:06:07.000Z',
    lastAttemptAt: '2026-03-04T05:06:07.000Z',
  });
}

const eventCount = () => db().select().from(events).all().length;
function thrown(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (e) {
    return e as DomainError;
  }
  throw new Error('expected a throw');
}

describe('inbox queries', () => {
  it('R24: on first run every active observation with a serial is in the inbox', () => {
    snapshot([obs('AAA'), obs('bbb'), obs('CCC', { state: 'decommissioned' })]);
    const inbox = getInbox(db(), P);
    expect(inbox.entries.map((e) => e.observationKey)).toEqual(['AAA', 'BBB']);
    expect(inbox.count).toBe(2);
    expect(inbox.entries.every((e) => e.suggestion === null)).toBe(true);
  });

  it('the inbox is empty without a snapshot (R32)', () => {
    expect(getInbox(db(), P)).toEqual({
      entries: [],
      unidentified: [],
      retiredCandidates: [],
      count: 0,
      matchedDriveIds: [],
    });
  });

  it('R25: a spare with the same serial is suggested, and GET changes nothing', () => {
    const spare = createDrive(db(), { serial: 'ab-1' });
    snapshot([obs(' AB-1 ')]);
    const before = eventCount();
    const inbox = getInbox(db(), P);
    expect(inbox.entries).toHaveLength(1);
    expect(inbox.entries[0]?.suggestion?.id).toBe(spare.id);
    expect(getDrive(db(), spare.id).status).toBe('spare');
    expect(eventCount()).toBe(before);
  });

  it('R9: an installed or retired record leaves the inbox', () => {
    const [slot] = slots();
    const a = createDrive(db(), { serial: 'A1' });
    assignDrive(db(), { driveId: a.id, slotId: slot! });
    createDrive(db(), { serial: 'R1' });
    snapshot([obs('A1'), obs('R1')]);
    // R1 is a spare here, so it is suggested; A1 is installed and not offered.
    expect(getInbox(db(), P).entries.map((e) => e.observationKey)).toEqual(['R1']);
  });

  it('R58: observations without a serial are unidentified, not in the inbox', () => {
    snapshot([obs(undefined, { model: 'empty' }), obs('   '), obs('A1')]);
    const inbox = getInbox(db(), P);
    expect(inbox.unidentified).toHaveLength(2);
    expect(inbox.entries.map((e) => e.observationKey)).toEqual(['A1']);
  });

  it('R2: the WWN matches only when no serial matches, case-insensitively', () => {
    const byWwn = createDrive(db(), { serial: 'OLD-SERIAL' }, { wwn: '0x5000AbCd' });
    const bySerial = createDrive(db(), { serial: 'S2' }, { wwn: '0xdead' });
    const all = listDrives(db());
    const result = matchObservations(all, [
      obs('NEW-SERIAL', { wwn: ' 0x5000abcd ' }),
      obs('s2', { wwn: '0x5000abcd' }), // serial wins over the other drive's WWN
      obs('NO-MATCH', { wwn: '0xffff' }),
    ]);
    expect(result.matchedByDriveId.get(byWwn.id)?.observation.serial).toBe('NEW-SERIAL');
    expect(result.matchedByDriveId.get(bySerial.id)?.observation.serial).toBe('s2');
    expect(result.inbox.map((e) => e.observationKey).sort()).toEqual([
      'NEW-SERIAL',
      'NO-MATCH',
      'S2',
    ]);
    expect(result.inbox.find((e) => e.observationKey === 'NO-MATCH')?.suggestion).toBeNull();
  });

  it('R2: never matches on anything but serial and WWN', () => {
    createDrive(db(), { serial: 'A1' });
    const result = matchObservations(listDrives(db()), [obs('B2', { model: 'x' })]);
    expect(result.matched).toHaveLength(0);
  });
});

describe('R63: retired candidates', () => {
  it('lists decommissioned observations with a serial and no record, with prefill and a health hint', () => {
    snapshot([
      obs('DEAD1', {
        state: 'decommissioned',
        health: 'failed',
        model: 'M1',
        capacityBytes: 4_000_000_000_000,
        driveType: 'HDD',
      }),
      obs('DEAD2', { state: 'decommissioned' }),
    ]);
    createDrive(db(), { serial: 'dead2' });
    expect(listRetiredCandidates(db(), P)).toEqual([
      {
        observationKey: 'DEAD1',
        serial: 'DEAD1',
        model: 'M1',
        capacityBytes: 4_000_000_000_000,
        driveType: 'HDD',
        retirementDate: '2026-03-04',
        healthHint: 'failed',
      },
    ]);
    // DEAD2 matches an existing record (the R10 case), so it is not offered.
    expect(getInbox(db(), P).retiredCandidates.map((c) => c.serial)).toEqual(['DEAD1']);
    expect(getInbox(db(), P).entries).toEqual([]);
  });

  it('imports with a reason per item, a prefilled date, and applies no health', () => {
    snapshot([
      obs('DEAD1', { state: 'decommissioned', health: 'failed', model: 'M1', wwn: '0xAA' }),
      obs('DEAD2', { state: 'decommissioned' }),
    ]);
    const result = importRetired(db(), P, {
      items: [
        { observationKey: 'DEAD1', reason: 'failed' },
        { observationKey: 'dead2', reason: 'replaced', date: '2025-12-01', note: 'old' },
      ],
    });
    expect(result.map((d) => [d.status, d.retirementReason, d.retirementDate])).toEqual([
      ['retired', 'failed', '2026-03-04'],
      ['retired', 'replaced', '2025-12-01'],
    ]);
    expect(result[0]?.model).toBe('M1');
    expect(result[0]?.wwn).toBe('0xAA');
    expect(eventsOfDrive(db(), result[0]!.id).map((e) => e.type)).toEqual([
      'drive-retired',
      'drive-created',
    ]);
    // Retirements on different days did not happen together: one `retired-imported` activity per item,
    // each dated with its own day, drive-created then drive-retired.
    const acts = activitiesOf(db()).filter((a) => a.kind === 'retired-imported');
    expect(acts).toHaveLength(2);
    expect(acts.map((a) => a.occurredOn)).toEqual(['2026-03-04', '2025-12-01']);
    expect(acts.map(shape)).toEqual([
      ['drive-created', 'drive-retired'],
      ['drive-created', 'drive-retired'],
    ]);
    expect(acts[1]!.events[1]!.payload).toEqual({ reason: 'replaced', note: 'old' });
    expect(listRetiredCandidates(db(), P)).toEqual([]);
  });

  it('R63, R60: an omitted date is the last-reported day, an explicit null is not recorded, a bad one is rejected', () => {
    snapshot([
      obs('DEAD1', { state: 'decommissioned' }),
      obs('DEAD2', { state: 'decommissioned' }),
      obs('DEAD3', { state: 'decommissioned' }),
    ]);
    const result = importRetired(db(), P, {
      items: [
        { observationKey: 'DEAD1', reason: 'failed' },
        { observationKey: 'DEAD2', reason: 'failed', date: null },
      ],
    });
    expect(result.map((d) => d.retirementDate)).toEqual(['2026-03-04', null]);
    expect(
      eventsOfDrive(db(), result[1]!.id).find((e) => e.type === 'drive-retired')!.payload,
    ).toEqual({ reason: 'failed', note: null });
    expect(lastActivity(db())).toMatchObject({ kind: 'retired-imported', occurredOn: null });
    const before = eventCount();
    expect(
      thrown(() =>
        importRetired(db(), P, {
          items: [{ observationKey: 'DEAD3', reason: 'failed', date: '2999-01-01' }],
        }),
      ).code,
    ).toBe('invalid');
    expect(eventCount()).toBe(before);
  });

  it('is all or nothing: an unknown item writes nothing', () => {
    snapshot([obs('DEAD1', { state: 'decommissioned' })]);
    const before = eventCount();
    const err = thrown(() =>
      importRetired(db(), P, {
        items: [
          { observationKey: 'DEAD1', reason: 'failed' },
          { observationKey: 'NOPE', reason: 'failed' },
        ],
      }),
    );
    expect(err.code).toBe('not-found');
    expect(listDrives(db())).toEqual([]);
    expect(eventCount()).toBe(before);
  });

  it('R63: rolls back earlier items when a later one fails inside the transaction', () => {
    snapshot([
      obs('DEAD1', { state: 'decommissioned' }),
      obs('DEAD2', { state: 'decommissioned' }),
    ]);
    opened.sqlite.exec(
      `CREATE TRIGGER fail_second BEFORE INSERT ON events
       WHEN NEW.type = 'drive-retired' AND (SELECT count(*) FROM events WHERE type = 'drive-retired') >= 1
       BEGIN SELECT RAISE(ABORT, 'boom'); END`,
    );
    expect(() =>
      importRetired(db(), P, {
        items: [
          { observationKey: 'DEAD1', reason: 'failed' },
          { observationKey: 'DEAD2', reason: 'failed' },
        ],
      }),
    ).toThrow(/boom/);
    expect(listDrives(db())).toEqual([]);
    expect(eventCount()).toBe(0);
  });
});

describe('resolving an inbox entry (R22, R23)', () => {
  it('links to a spare: fills only missing fields; ONE discovered-linked activity of drive-linked + drive-installed', () => {
    const [slot] = slots();
    const spare = createDrive(db(), { serial: 'ab-1', model: 'Mine' });
    snapshot([
      obs('AB-1', {
        model: 'Theirs',
        capacityBytes: 8_000_000_000_000,
        wwn: '0x1',
        driveType: 'HDD',
      }),
    ]);
    const { drive } = linkObservation(db(), P, 'ab-1', { driveId: spare.id, slotId: slot! });
    expect(drive).toMatchObject({
      status: 'installed',
      slotId: slot,
      model: 'Mine',
      capacityBytes: 8_000_000_000_000,
      wwn: '0x1',
      driveType: 'HDD',
    });
    const types = eventsOfDrive(db(), spare.id).map((e) => e.type);
    expect(types).toEqual(['drive-installed', 'drive-linked', 'drive-created']);
    const act = lastActivity(db());
    expect(act.kind).toBe('discovered-linked');
    expect(shape(act)).toEqual(['drive-linked', 'drive-installed']);
    // Each filled field carries what it was, so the link can be undone as well as replayed.
    expect(act.events[0]!.payload).toEqual({
      observationSerial: 'AB-1',
      filled: {
        wwn: { from: null, to: '0x1' },
        capacityBytes: { from: null, to: 8_000_000_000_000 },
        driveType: { from: null, to: 'HDD' },
      },
    });
    expect(getInbox(db(), P).entries).toEqual([]);
  });

  it('creates a record from the observation and installs it', () => {
    const [slot] = slots();
    snapshot([obs('NEW1', { model: 'M', capacityBytes: 1000, formFactor: '3.5', wwn: '0xBEEF' })]);
    const { drive } = createFromObservation(db(), P, 'new1', {
      slotId: slot!,
      vendor: 'Shop',
    });
    expect(drive).toMatchObject({
      serial: 'NEW1',
      model: 'M',
      capacityBytes: 1000,
      formFactor: '3.5',
      wwn: '0xBEEF',
      vendor: 'Shop',
      status: 'installed',
      slotId: slot,
    });
    expect(eventsOfDrive(db(), drive.id).map((e) => e.type)).toEqual([
      'drive-installed',
      'drive-created',
    ]);
    // One discovered-created activity holds both.
    const act = lastActivity(db());
    expect(act.kind).toBe('discovered-created');
    expect(shape(act)).toEqual(['drive-created', 'drive-installed']);
    expect(getInbox(db(), P).count).toBe(0);
  });

  it('create: an occupied slot fails atomically, with no drive and no event', () => {
    const [slot] = slots();
    const holder = createDrive(db(), { serial: 'HOLD' });
    assignDrive(db(), { driveId: holder.id, slotId: slot! });
    snapshot([obs('NEW1'), obs('HOLD')]);
    const drivesBefore = listDrives(db()).length;
    const eventsBefore = eventCount();
    const err = thrown(() => createFromObservation(db(), P, 'NEW1', { slotId: slot! }));
    expect(err.code).toBe('conflict');
    expect(listDrives(db())).toHaveLength(drivesBefore);
    expect(eventCount()).toBe(eventsBefore);
    expect(getInbox(db(), P).entries.map((e) => e.observationKey)).toEqual(['NEW1']);
  });

  it('link: an occupied slot fails atomically, leaving the spare unfilled and unlogged', () => {
    const [slot] = slots();
    const holder = createDrive(db(), { serial: 'HOLD' });
    assignDrive(db(), { driveId: holder.id, slotId: slot! });
    const spare = createDrive(db(), { serial: 'SP1' });
    snapshot([obs('SP1', { model: 'M', wwn: '0x1' })]);
    const eventsBefore = eventCount();
    expect(
      thrown(() => linkObservation(db(), P, 'SP1', { driveId: spare.id, slotId: slot! })).code,
    ).toBe('conflict');
    expect(getDrive(db(), spare.id)).toMatchObject({ status: 'spare', model: null, wwn: null });
    expect(eventCount()).toBe(eventsBefore);
  });

  it('link: occupant resolution passes through to assignment', () => {
    const [slot] = slots();
    const holder = createDrive(db(), { serial: 'HOLD' });
    assignDrive(db(), { driveId: holder.id, slotId: slot! });
    const spare = createDrive(db(), { serial: 'SP1' });
    snapshot([obs('SP1')]);
    const result = linkObservation(db(), P, 'SP1', {
      driveId: spare.id,
      slotId: slot!,
      occupant: { action: 'spare' },
    });
    expect(result.drive.slotId).toBe(slot);
    expect(result.occupant?.status).toBe('spare');
  });

  it('rejects linking to a missing drive and takes over the serial of a differently numbered spare', () => {
    const [slot, slot2] = slots();
    const installed = createDrive(db(), { serial: 'INS' });
    assignDrive(db(), { driveId: installed.id, slotId: slot! });
    const other = createDrive(db(), { serial: 'OTHER' });
    snapshot([obs('NEW1'), obs('NEW2', { wwn: '0x9' })]);
    expect(
      thrown(() => linkObservation(db(), P, 'NEW1', { driveId: 'nope', slotId: slot2! })).code,
    ).toBe('not-found');
    // R22 (2026-10-23): a differently numbered spare is linked and takes over the reported serial.
    const linked = linkObservation(db(), P, 'NEW2', { driveId: other.id, slotId: slot2! });
    expect(linked.drive).toMatchObject({ serial: 'NEW2', wwn: '0x9', status: 'installed' });
    expect(getInbox(db(), P).entries.map((e) => e.observationKey)).toEqual(['NEW1']);
  });

  it('requires the observation to be in the inbox', () => {
    const [slot] = slots();
    const d = createDrive(db(), { serial: 'INS' });
    assignDrive(db(), { driveId: d.id, slotId: slot! });
    snapshot([obs('INS'), obs('GONE', { state: 'decommissioned' })]);
    expect(thrown(() => createFromObservation(db(), P, 'INS', { slotId: slot! })).code).toBe(
      'conflict',
    );
    expect(thrown(() => createFromObservation(db(), P, 'GONE', { slotId: slot! })).code).toBe(
      'conflict',
    );
    expect(thrown(() => createFromObservation(db(), P, 'UNKNOWN', { slotId: slot! })).code).toBe(
      'not-found',
    );
  });
});

describe('R22: linking to any drive without live data', () => {
  /** The owner's case: added with the sticker serial, installed in a bay, the NAS reports "WD-<serial>". */
  function stickerDrive(extra: Record<string, unknown> = {}) {
    const [slot] = slots();
    const d = createDrive(db(), { serial: 'STICK1', ...extra });
    assignDrive(db(), { driveId: d.id, slotId: slot!, installedOn: '2024-01-01' });
    return { d, slot: slot! };
  }
  const inboxObs = () => obs('WD-STICK1', { wwn: '0xabc', model: 'WD Red', capacityBytes: 4e12 });

  it('links an installed drive: it keeps its bay and date, ONE discovered-linked activity holds only drive-linked', () => {
    const { d, slot } = stickerDrive();
    snapshot([inboxObs()]);
    const before = activitiesOf(db()).length;
    const result = linkObservation(db(), P, 'WD-STICK1', { driveId: d.id });
    expect(result.drive).toMatchObject({
      status: 'installed',
      slotId: slot,
      installedOn: '2024-01-01',
      wwn: '0xabc',
      model: 'WD Red',
      capacityBytes: 4e12,
    });
    expect(activitiesOf(db())).toHaveLength(before + 1);
    const act = lastActivity(db());
    expect(act.kind).toBe('discovered-linked');
    expect(act.events.map((e) => e.type)).toEqual(['drive-linked']);
    expect(act.events[0]!.payload).toMatchObject({
      observationSerial: 'WD-STICK1',
      filled: { wwn: { from: null, to: '0xabc' }, model: { from: null, to: 'WD Red' } },
    });
    expect(getInbox(db(), P).entries).toEqual([]);
  });

  it('an installed drive refuses placement fields (400), and nothing is applied', () => {
    const { d } = stickerDrive();
    snapshot([inboxObs()]);
    const [, other] = slots();
    for (const extra of [{ slotId: other! }, { installedOn: '2024-02-02' }, { role: 'data' }]) {
      const err = thrown(() =>
        linkObservation(db(), P, 'WD-STICK1', { driveId: d.id, ...extra } as never),
      );
      expect(err.code).toBe('invalid');
    }
    expect(getDrive(db(), d.id)).toMatchObject({ wwn: null, model: null });
  });

  it('a spare still needs a slot (400) and is installed there as before', () => {
    const [slot] = slots();
    const spare = createDrive(db(), { serial: 'WD-STICK1' });
    snapshot([inboxObs()]);
    expect(thrown(() => linkObservation(db(), P, 'WD-STICK1', { driveId: spare.id })).code).toBe(
      'invalid',
    );
    const r = linkObservation(db(), P, 'WD-STICK1', { driveId: spare.id, slotId: slot! });
    expect(r.drive).toMatchObject({ status: 'installed', slotId: slot });
    expect(lastActivity(db()).events.map((e) => e.type)).toEqual([
      'drive-linked',
      'drive-installed',
    ]);
  });

  it('refuses a retired drive (409)', () => {
    const d = createDrive(db(), { serial: 'STICK1' });
    retireDrive(db(), d.id, { reason: 'failed' });
    snapshot([inboxObs()]);
    const before = eventCount();
    expect(thrown(() => linkObservation(db(), P, 'WD-STICK1', { driveId: d.id })).code).toBe(
      'conflict',
    );
    expect(eventCount()).toBe(before);
  });

  it('refuses a drive that already matches another observation, naming its serial (409)', () => {
    const { d } = stickerDrive();
    db().update(drives).set({ wwn: '0x1' }).where(eq(drives.id, d.id)).run();
    snapshot([obs('STICK1', { wwn: '0x1' }), obs('WD-STICK1', { wwn: '0xabc' })]);
    const before = eventCount();
    const err = thrown(() => linkObservation(db(), P, 'WD-STICK1', { driveId: d.id }));
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/already matches the observation STICK1/);
    expect(eventCount()).toBe(before);
  });

  it('R22: an installed drive takes over the reported serial; ONE activity, drive-linked carries serial from/to', () => {
    const { d, slot } = stickerDrive();
    snapshot([obs('WD-STICK1')]); // no WWN to fill: the serial alone makes the link
    const before = activitiesOf(db()).length;
    const result = linkObservation(db(), P, 'WD-STICK1', { driveId: d.id });
    expect(result.drive).toMatchObject({ serial: 'WD-STICK1', status: 'installed', slotId: slot });
    expect(getDrive(db(), d.id).serialNormalized).toBe('WD-STICK1');
    expect(activitiesOf(db())).toHaveLength(before + 1);
    expect(lastActivity(db()).events.map((e) => e.type)).toEqual(['drive-linked']);
    expect(lastActivity(db()).events[0]!.payload).toMatchObject({
      filled: { serial: { from: 'STICK1', to: 'WD-STICK1' } },
    });
    expect(getInbox(db(), P).entries).toEqual([]);
  });

  it('R22: a spare takes over the reported serial (trimmed, as reported) when it is installed', () => {
    const [slot] = slots();
    const spare = createDrive(db(), { serial: 'stick1' });
    snapshot([obs('  WD-Stick1 ')]);
    const r = linkObservation(db(), P, 'WD-STICK1', { driveId: spare.id, slotId: slot! });
    expect(r.drive).toMatchObject({ serial: 'WD-Stick1', status: 'installed' });
    expect(lastActivity(db()).events[0]!.payload).toMatchObject({
      filled: { serial: { from: 'stick1', to: 'WD-Stick1' } },
    });
  });

  it('R22: a case-only difference changes nothing about the serial (normalized equal)', () => {
    const [slot] = slots();
    const spare = createDrive(db(), { serial: 'Case-1' });
    snapshot([obs('CASE-1', { wwn: '0xabc' })]); // the R25 suggestion: same normalized serial
    const r = linkObservation(db(), P, 'CASE-1', { driveId: spare.id, slotId: slot! });
    expect(r.drive.serial).toBe('Case-1');
    const payload = lastActivity(db()).events[0]!.payload as { filled: Record<string, unknown> };
    expect(payload.filled).not.toHaveProperty('serial');
    expect(payload.filled).toHaveProperty('wwn');
  });

  it('R22: refuses when another record (even retired) holds the reported serial; nothing written', () => {
    const { d } = stickerDrive();
    const old = createDrive(db(), { serial: 'WD-STICK1' });
    retireDrive(db(), old.id, { reason: 'failed' });
    snapshot([obs('WD-STICK1', { wwn: '0xabc' })]);
    const before = eventCount();
    const err = thrown(() => linkObservation(db(), P, 'WD-STICK1', { driveId: d.id }));
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/WD-STICK1/);
    expect(getDrive(db(), d.id)).toMatchObject({ serial: 'STICK1', wwn: null });
    expect(eventCount()).toBe(before);
  });

  it('API: the link takes the serial over (200) or names the holder (409)', async () => {
    const { d } = stickerDrive();
    const app = await buildApp({ db: db(), provider: fakeProvider });
    snapshot([obs('WD-STICK1')]);
    const ok = await app.inject({
      method: 'POST',
      url: '/api/inbox/WD-STICK1/link',
      payload: { driveId: d.id },
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().drive).toMatchObject({ id: d.id, serial: 'WD-STICK1' });
    const other = createDrive(db(), { serial: 'MINE2' });
    createDrive(db(), { serial: 'TAKEN' });
    snapshot([obs('TAKEN')]);
    const [, slot] = slots();
    const clash = await app.inject({
      method: 'POST',
      url: '/api/inbox/TAKEN/link',
      payload: { driveId: other.id, slotId: slot },
    });
    expect(clash.statusCode).toBe(409);
    expect(clash.json().error.message ?? clash.body).toMatch(/TAKEN/);
  });

  it('refuses to copy a WWN another record holds (409)', () => {
    const { d } = stickerDrive();
    const holder = createDrive(db(), { serial: 'HOLDER' });
    db().update(drives).set({ wwn: '0xabc' }).where(eq(drives.id, holder.id)).run();
    snapshot([inboxObs()]);
    expect(thrown(() => linkObservation(db(), P, 'WD-STICK1', { driveId: d.id })).code).toBe(
      'conflict',
    );
  });

  it('GET /api/inbox lists the drives that currently match an observation', () => {
    const { d } = stickerDrive();
    const free = createDrive(db(), { serial: 'FREE' });
    snapshot([obs('STICK1'), inboxObs()]);
    const ids = getInbox(db(), P).matchedDriveIds;
    expect(ids).toContain(d.id);
    expect(ids).not.toContain(free.id);
  });

  it('API: 400 for placement on an installed drive, 409 for a retired one, 200 for the link', async () => {
    const { d } = stickerDrive();
    const retired = createDrive(db(), { serial: 'OLD' });
    retireDrive(db(), retired.id, { reason: 'failed' });
    snapshot([inboxObs()]);
    const app = await buildApp({ db: db(), provider: fakeProvider });
    const url = '/api/inbox/WD-STICK1/link';
    const bad = await app.inject({
      method: 'POST',
      url,
      payload: { driveId: d.id, slotId: slots()[1] },
    });
    expect(bad.statusCode).toBe(400);
    const gone = await app.inject({ method: 'POST', url, payload: { driveId: retired.id } });
    expect(gone.statusCode).toBe(409);
    const ok = await app.inject({ method: 'POST', url, payload: { driveId: d.id } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().drive).toMatchObject({ id: d.id, wwn: '0xabc' });
  });
});

describe('R22, R26, R2: linking must leave the observation matched to the linked drive', () => {
  it('takes over the serial of a spare with a different serial and WWN', () => {
    const [slot] = slots();
    const spare = createDrive(db(), { serial: 'DIFFERENT' }, { wwn: '0x111' });
    snapshot([obs('OBS-1', { wwn: '0xabc', model: 'M' })]);
    const r = linkObservation(db(), P, 'OBS-1', { driveId: spare.id, slotId: slot! });
    expect(r.drive).toMatchObject({
      serial: 'OBS-1',
      model: 'M',
      wwn: '0x111',
      status: 'installed',
    });
    expect(getInbox(db(), P).entries).toEqual([]);
  });

  it('rejects when the WWN is already held by another record (case-insensitive), changing nothing', () => {
    const [slot] = slots();
    createDrive(db(), { serial: 'HOLDER' }, { wwn: ' 0xABC ' });
    const spare = createDrive(db(), { serial: 'SP-2' });
    snapshot([obs('OBS-2', { wwn: '0xabc' })]);
    const eventsBefore = eventCount();
    const err = thrown(() =>
      linkObservation(db(), P, 'OBS-2', { driveId: spare.id, slotId: slot! }),
    );
    expect(err.code).toBe('conflict');
    expect(getDrive(db(), spare.id)).toMatchObject({ status: 'spare', wwn: null });
    expect(eventCount()).toBe(eventsBefore);
  });

  it('rejects when another record already holds the reported serial (409, never a 500), changing nothing', () => {
    const [slot] = slots();
    // OBS-3 matches a record by serial, so linking it to another spare cannot take the serial over.
    createDrive(db(), { serial: 'OBS-3' });
    const other = createDrive(db(), { serial: 'OTHER-3' });
    snapshot([obs('OBS-3', { wwn: '0xdef' })]);
    const eventsBefore = eventCount();
    const err = thrown(() =>
      linkObservation(db(), P, 'OBS-3', { driveId: other.id, slotId: slot! }),
    );
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/OBS-3/);
    expect(getDrive(db(), other.id)).toMatchObject({
      serial: 'OTHER-3',
      status: 'spare',
      wwn: null,
    });
    expect(eventCount()).toBe(eventsBefore);
  });
});

describe('R55: the inbox ignores a snapshot from another provider', () => {
  it('shows nothing while the cache belongs to a different provider', () => {
    snapshot([obs('AAA')]);
    expect(getInbox(db(), 'other').count).toBe(0);
    expect(getInbox(db(), 'other').retiredCandidates).toEqual([]);
    expect(getInbox(db(), P).count).toBe(1);
  });
});

describe('internal parse failures are server errors, not client 400s', () => {
  it('an observation that yields an invalid drive record fails as a plain Error, nothing written', async () => {
    const [slot] = slots();
    snapshot([obs('L'.repeat(150))]);
    const eventsBefore = eventCount();
    let caught: unknown;
    try {
      createFromObservation(db(), P, 'L'.repeat(150), { slotId: slot! });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(ZodError);
    expect(caught).not.toBeInstanceOf(DomainError);
    expect(listDrives(db())).toEqual([]);
    expect(eventCount()).toBe(eventsBefore);
    // (The 500 mapping is covered in api-errors.test.ts; a long model no longer triggers it, R72.)
  });
});

describe('inbox API', () => {
  it('serves the inbox, resolves entries, and maps errors', async () => {
    const [slot, slot2] = slots();
    const app = await buildApp({ db: db(), provider: fakeProvider });
    snapshot([
      obs('A/1', { model: 'M' }),
      obs(undefined),
      obs('DEAD', { state: 'decommissioned', health: 'warning' }),
    ]);
    const got = await app.inject({ method: 'GET', url: '/api/inbox' });
    expect(got.statusCode).toBe(200);
    expect(got.json()).toMatchObject({
      count: 1,
      unidentified: [{}],
      retiredCandidates: [{ serial: 'DEAD', healthHint: 'warning' }],
    });

    const bad = await app.inject({
      method: 'POST',
      url: '/api/inbox/import-retired',
      payload: { items: [{ observationKey: 'DEAD' }] },
    });
    expect(bad.statusCode).toBe(400);
    expect(listDrives(db())).toEqual([]);

    const empty = await app.inject({
      method: 'POST',
      url: '/api/inbox/import-retired',
      payload: { items: [] },
    });
    expect(empty.statusCode).toBe(400);

    const created = await app.inject({
      method: 'POST',
      url: `/api/inbox/${encodeURIComponent('A/1')}/create`,
      payload: { slotId: slot },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().drive).toMatchObject({ serial: 'A/1', status: 'installed' });

    const again = await app.inject({
      method: 'POST',
      url: `/api/inbox/${encodeURIComponent('A/1')}/create`,
      payload: { slotId: slot2 },
    });
    expect(again.statusCode).toBe(409);
    const missing = await app.inject({
      method: 'POST',
      url: '/api/inbox/ZZZ/create',
      payload: { slotId: slot2 },
    });
    expect(missing.statusCode).toBe(404);

    const imported = await app.inject({
      method: 'POST',
      url: '/api/inbox/import-retired',
      payload: { items: [{ observationKey: 'DEAD', reason: 'failed' }] },
    });
    expect(imported.statusCode).toBe(200);
    expect(imported.json()[0]).toMatchObject({ status: 'retired', retirementDate: '2026-03-04' });
    await app.close();
  });
});
