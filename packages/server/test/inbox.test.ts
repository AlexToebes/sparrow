import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Observation } from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { assignDrive } from '../src/core/assignment.js';
import { createDrive, getDrive, listDrives } from '../src/core/drives.js';
import { DomainError } from '../src/core/errors.js';
import { listDriveEvents } from '../src/core/events.js';
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
import { events } from '../src/db/schema.js';

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
    expect(listDriveEvents(db(), result[0]!.id).map((e) => e.type)).toEqual([
      'drive-retired',
      'drive-created',
    ]);
    expect(listRetiredCandidates(db(), P)).toEqual([]);
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
  it('links to a spare: fills only missing fields, writes drive-linked, installs in the slot', () => {
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
    const types = listDriveEvents(db(), spare.id).map((e) => e.type);
    expect(types).toEqual(['drive-installed', 'drive-linked', 'drive-created']);
    const linked = listDriveEvents(db(), spare.id).find((e) => e.type === 'drive-linked');
    expect(linked?.payload.filled).toEqual({
      wwn: '0x1',
      capacityBytes: 8_000_000_000_000,
      driveType: 'HDD',
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
    expect(listDriveEvents(db(), drive.id).map((e) => e.type)).toEqual([
      'drive-installed',
      'drive-created',
    ]);
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

  it('rejects linking to a non-spare, a missing drive, or a drive the observation cannot match', () => {
    const [slot, slot2] = slots();
    const installed = createDrive(db(), { serial: 'INS' });
    assignDrive(db(), { driveId: installed.id, slotId: slot! });
    const other = createDrive(db(), { serial: 'OTHER' });
    snapshot([obs('NEW1'), obs('NEW2', { wwn: '0x9' })]);
    expect(
      thrown(() => linkObservation(db(), P, 'NEW1', { driveId: installed.id, slotId: slot2! }))
        .code,
    ).toBe('conflict');
    expect(
      thrown(() => linkObservation(db(), P, 'NEW1', { driveId: 'nope', slotId: slot2! })).code,
    ).toBe('not-found');
    expect(
      thrown(() => linkObservation(db(), P, 'NEW1', { driveId: other.id, slotId: slot2! })).code,
    ).toBe('conflict');
    // With a WWN the observation can be linked to a differently numbered spare.
    const linked = linkObservation(db(), P, 'NEW2', { driveId: other.id, slotId: slot2! });
    expect(linked.drive).toMatchObject({ serial: 'OTHER', wwn: '0x9', status: 'installed' });
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

describe('R22, R26, R2: linking must leave the observation matched to the linked drive', () => {
  it('rejects a spare with a different serial and a different WWN, changing nothing', () => {
    const [slot] = slots();
    const spare = createDrive(db(), { serial: 'DIFFERENT' }, { wwn: '0x111' });
    snapshot([obs('OBS-1', { wwn: '0xabc', model: 'M' })]);
    const eventsBefore = eventCount();
    const err = thrown(() =>
      linkObservation(db(), P, 'OBS-1', { driveId: spare.id, slotId: slot! }),
    );
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/stay unmatched/);
    expect(getDrive(db(), spare.id)).toMatchObject({ status: 'spare', model: null, wwn: '0x111' });
    expect(eventCount()).toBe(eventsBefore);
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

  it('rejects when the observation would still resolve to a different record', () => {
    const [slot] = slots();
    // OBS-3 matches a record by serial, so linking it to another spare (even with a WWN) cannot work.
    createDrive(db(), { serial: 'OBS-3' });
    const other = createDrive(db(), { serial: 'OTHER-3' });
    snapshot([obs('OBS-3', { wwn: '0xdef' })]);
    const eventsBefore = eventCount();
    const err = thrown(() =>
      linkObservation(db(), P, 'OBS-3', { driveId: other.id, slotId: slot! }),
    );
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/unmatched|match/);
    expect(getDrive(db(), other.id)).toMatchObject({ status: 'spare', wwn: null });
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
