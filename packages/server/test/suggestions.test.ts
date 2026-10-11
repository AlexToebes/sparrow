import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Observation } from '@sparrow/shared';
import { buildApp } from '../src/api/app.js';
import { createDrive, getDrive, updateDrive } from '../src/core/drives.js';
import { DomainError } from '../src/core/errors.js';
import { listDriveEvents } from '../src/core/events.js';
import type { DriveDataProvider } from '../src/core/provider-port.js';
import {
  applySuggestions,
  getDriveSuggestions,
  getSuggestionSummary,
} from '../src/core/suggestions.js';
import { openDatabase, type OpenedDatabase } from '../src/db/client.js';
import { createRepositories } from '../src/db/repositories.js';

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

const obs = (serial: string | undefined, extra: Partial<Observation> = {}): Observation => ({
  ...(serial === undefined ? {} : { serial }),
  health: 'ok',
  lastReportedAt: '2026-03-04T05:06:07.000Z',
  state: 'active',
  ...extra,
});

function snapshot(observations: Observation[], providerId = 'fake') {
  createRepositories(db()).snapshot.put({
    providerId,
    observations,
    lastSuccessAt: '2026-03-04T05:06:07.000Z',
    lastAttemptAt: '2026-03-04T05:06:07.000Z',
  });
}

function thrown(fn: () => unknown): DomainError {
  try {
    fn();
  } catch (e) {
    return e as DomainError;
  }
  throw new Error('expected a throw');
}

describe('suggested updates (R72, R54)', () => {
  it('R72: a record missing values gets one "fill" suggestion per value the observation has', () => {
    const d = createDrive(db(), { serial: 'AAA1' });
    snapshot([
      obs('aaa1', {
        model: ' WDC WD80 ',
        capacityBytes: 8e12,
        driveType: 'HDD',
        formFactor: '3.5"',
        wwn: '0x5000',
      }),
    ]);
    expect(getDriveSuggestions(db(), P, d.id)).toEqual([
      { field: 'model', kind: 'fill', current: null, suggested: 'WDC WD80' },
      { field: 'capacityBytes', kind: 'fill', current: null, suggested: 8e12 },
      { field: 'driveType', kind: 'fill', current: null, suggested: 'HDD' },
      { field: 'formFactor', kind: 'fill', current: null, suggested: '3.5"' },
      { field: 'wwn', kind: 'fill', current: null, suggested: '0x5000' },
    ]);
  });

  it('R72: fields the observation does not report, or reports blank, are not suggested', () => {
    const d = createDrive(db(), { serial: 'AAA1' });
    snapshot([obs('AAA1', { model: '   ' })]);
    expect(getDriveSuggestions(db(), P, d.id)).toEqual([]);
  });

  it('R72: equal values are not suggested; model and WWN compare trimmed and case-insensitively', () => {
    const d = createDrive(
      db(),
      { serial: 'AAA1', model: 'Wdc Wd80', capacityBytes: 8e12, driveType: 'HDD' },
      { wwn: '0xABCD' },
    );
    snapshot([
      obs('AAA1', {
        model: ' WDC WD80 ',
        wwn: '0xabcd',
        capacityBytes: 8e12,
        driveType: 'HDD',
      }),
    ]);
    expect(getDriveSuggestions(db(), P, d.id)).toEqual([]);
  });

  it('R72: differing values are "differs" with both values; capacity and type compare exactly', () => {
    const d = createDrive(db(), {
      serial: 'AAA1',
      model: 'Old',
      capacityBytes: 8e12,
      driveType: 'HDD',
    });
    snapshot([obs('AAA1', { model: 'New', capacityBytes: 8000000000001, driveType: 'SSD' })]);
    expect(getDriveSuggestions(db(), P, d.id)).toEqual([
      { field: 'model', kind: 'differs', current: 'Old', suggested: 'New' },
      { field: 'capacityBytes', kind: 'differs', current: 8e12, suggested: 8000000000001 },
      { field: 'driveType', kind: 'differs', current: 'HDD', suggested: 'SSD' },
    ]);
  });

  it('R72: a decommissioned match of a retired or installed record is still compared', () => {
    const d = createDrive(db(), { serial: 'AAA1' });
    snapshot([obs('AAA1', { state: 'decommissioned', model: 'M' })]);
    expect(getDriveSuggestions(db(), P, d.id)).toHaveLength(1);
  });

  it('R2: the WWN fallback match supplies suggestions too', () => {
    const d = createDrive(db(), { serial: 'AAA1' }, { wwn: '0x1' });
    snapshot([obs('OTHER', { wwn: '0x1', model: 'M' })]);
    expect(getDriveSuggestions(db(), P, d.id).map((s) => s.field)).toEqual(['model']);
  });

  it('R72: no matching observation means no suggestions', () => {
    const d = createDrive(db(), { serial: 'AAA1' });
    expect(getDriveSuggestions(db(), P, d.id)).toEqual([]);
    snapshot([obs('ZZZ', { model: 'M' })]);
    expect(getDriveSuggestions(db(), P, d.id)).toEqual([]);
    expect(getSuggestionSummary(db(), P)).toEqual({ byDriveId: {} });
  });

  it('R55: a snapshot written by another provider is ignored', () => {
    const d = createDrive(db(), { serial: 'AAA1' });
    snapshot([obs('AAA1', { model: 'M' })], 'someone-else');
    expect(getDriveSuggestions(db(), P, d.id)).toEqual([]);
    expect(getSuggestionSummary(db(), P)).toEqual({ byDriveId: {} });
  });

  it('R54: suggestions follow the snapshot on every read and nothing is stored', () => {
    const d = createDrive(db(), { serial: 'AAA1' });
    snapshot([obs('AAA1', { model: 'M1' })]);
    expect(getDriveSuggestions(db(), P, d.id)[0]?.suggested).toBe('M1');
    snapshot([obs('AAA1', { model: 'M2' })]);
    expect(getDriveSuggestions(db(), P, d.id)[0]?.suggested).toBe('M2');
    expect(listDriveEvents(db(), d.id)).toHaveLength(1); // only drive-created
  });

  it('R72: the summary counts fill and differs per drive and names the fill fields', () => {
    const a = createDrive(db(), { serial: 'AAA1', model: 'Old' });
    createDrive(db(), { serial: 'BBB2', model: 'Same' });
    snapshot([obs('AAA1', { model: 'New', capacityBytes: 4e12 }), obs('BBB2', { model: 'same' })]);
    expect(getSuggestionSummary(db(), P)).toEqual({
      byDriveId: { [a.id]: { fill: 1, differs: 1, fillFields: ['capacityBytes'] } },
    });
  });

  it('R72, R14: apply writes the values and ONE drive-updated event with source provider', () => {
    const d = createDrive(db(), { serial: 'AAA1', model: 'Old' });
    snapshot([obs('AAA1', { model: 'New', capacityBytes: 8e12, driveType: 'HDD' })]);
    const updated = applySuggestions(db(), P, d.id, ['capacityBytes', 'model']);
    expect(updated).toMatchObject({ model: 'New', capacityBytes: 8e12, driveType: null });
    const [event, ...rest] = listDriveEvents(db(), d.id);
    expect(rest).toHaveLength(1); // drive-created
    expect(event).toMatchObject({
      type: 'drive-updated',
      payload: {
        source: 'provider',
        changes: {
          model: { from: 'Old', to: 'New' },
          capacityBytes: { from: null, to: 8e12 },
        },
      },
    });
    // R53: no provider id or vocabulary is stored
    expect(JSON.stringify(event?.payload)).not.toContain('fake');
    expect(getDriveSuggestions(db(), P, d.id).map((s) => s.field)).toEqual(['driveType']);
  });

  it('R72: applying a field that is not (or no longer) suggested is a conflict and changes nothing', () => {
    const d = createDrive(db(), { serial: 'AAA1' });
    snapshot([obs('AAA1', { model: 'M' })]);
    const err = thrown(() => applySuggestions(db(), P, d.id, ['model', 'capacityBytes']));
    expect(err.code).toBe('conflict');
    expect(err.message).toMatch(/no longer applies/);
    expect(getDrive(db(), d.id).model).toBeNull();
    expect(listDriveEvents(db(), d.id)).toHaveLength(1);

    updateDrive(db(), d.id, { model: 'M' }); // edited by hand since: model no longer suggested
    expect(thrown(() => applySuggestions(db(), P, d.id, ['model'])).code).toBe('conflict');
  });

  it('R72: an unknown drive is not found', () => {
    expect(thrown(() => getDriveSuggestions(db(), P, 'nope')).code).toBe('not-found');
    expect(thrown(() => applySuggestions(db(), P, 'nope', ['model'])).code).toBe('not-found');
  });

  it('R2, D6: applying a WWN another record holds is a conflict and rolls everything back', () => {
    createDrive(db(), { serial: 'HOLDER' }, { wwn: '0xAA' });
    const d = createDrive(db(), { serial: 'AAA1' });
    snapshot([obs('AAA1', { model: 'M', wwn: '0xaa' })]);
    const err = thrown(() => applySuggestions(db(), P, d.id, ['model', 'wwn']));
    expect(err.code).toBe('conflict');
    expect(getDrive(db(), d.id).model).toBeNull();
    expect(listDriveEvents(db(), d.id)).toHaveLength(1);
  });
});

describe('suggested updates API (R72)', () => {
  it('serves per-drive and summary reads and applies on POST, mapping errors', async () => {
    const app = await buildApp({ db: db(), provider: fakeProvider });
    const d = createDrive(db(), { serial: 'AAA1' });
    snapshot([obs('AAA1', { model: 'M', capacityBytes: 4e12 })]);

    const got = await app.inject({ method: 'GET', url: `/api/drives/${d.id}/suggestions` });
    expect(got.statusCode).toBe(200);
    expect(got.json().suggestions).toHaveLength(2);
    expect(
      (await app.inject({ method: 'GET', url: '/api/drives/nope/suggestions' })).statusCode,
    ).toBe(404);
    const summary = await app.inject({ method: 'GET', url: '/api/suggestions' });
    expect(summary.json()).toEqual({
      byDriveId: { [d.id]: { fill: 2, differs: 0, fillFields: ['model', 'capacityBytes'] } },
    });

    const url = `/api/drives/${d.id}/suggestions/apply`;
    expect((await app.inject({ method: 'POST', url, payload: { fields: [] } })).statusCode).toBe(
      400,
    );
    expect(
      (await app.inject({ method: 'POST', url, payload: { fields: ['serial'] } })).statusCode,
    ).toBe(400);
    const ok = await app.inject({ method: 'POST', url, payload: { fields: ['model'] } });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ id: d.id, model: 'M', capacityBytes: null });
    const again = await app.inject({ method: 'POST', url, payload: { fields: ['model'] } });
    expect(again.statusCode).toBe(409);
    await app.close();
  });
});
